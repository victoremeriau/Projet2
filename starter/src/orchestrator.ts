import { query } from '@anthropic-ai/claude-agent-sdk';
import { ReviewReport, ReviewReportSchema } from './types/index.js';
import { logger } from './utils/logger.js';
import { mcpServersConfig } from './config/mcp.config.js';
import {
  codeQualityAnalyzerAgent,
  testCoverageAnalyzerAgent,
  refactoringSuggesterAgent
} from './agents/index.js';
import { orchestratorPrompt } from './prompts/index.js';

/**
 * Orchestrator configuration options
 */
export interface OrchestratorOptions {
}

/**
 * Main Code Review Orchestrator
 * Coordinates subagents to analyze pull requests and generate comprehensive reports
 */
export class CodeReviewOrchestrator {
  constructor(options: OrchestratorOptions = {}) {
  }

  /**
   * Review a pull request using multi-agent analysis
   * @param owner - Repository owner
   * @param repo - Repository name
   * @param prNumber - Pull request number
   * @returns Complete review report
   */
  async reviewPullRequest(
    owner: string,
    repo: string,
    prNumber: number
  ): Promise<ReviewReport> {
    const startTime = Date.now();

    logger.info(`Starting code review for ${owner}/${repo} PR #${prNumber}`);

    try {
      // Prepare the analysis prompt
      const prompt = `${orchestratorPrompt}

Please analyze this GitHub pull request:
- Owner: ${owner}
- Repository: ${repo}
- PR Number: ${prNumber}

Fetch the PR data from GitHub, analyze all changed files for code quality, test coverage, and refactoring opportunities.
Use the code-quality-analyzer, test-coverage-analyzer, and refactoring-suggester agents for comprehensive analysis.
Return a detailed JSON report with all findings matching the ReviewReport schema.`;

      logger.debug('Initializing orchestrator query');

      // Call the SDK query function
      const result = query({
        prompt: prompt,
        options: {
          model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5-20250929',
          allowedTools: [
            'Task',
            'Skill',
            'Read',
            'Grep',
            'Glob',
            'mcp__github__get_pull_request',
            'mcp__github__get_pull_request_files',
            'mcp__github__get_issue',
            'mcp__github__search_repositories',
            'mcp__github__get_file_contents',
            'mcp__github__create_issue',
            'mcp__github__update_issue',
            'mcp__github__create_pull_request',
            'mcp__github__update_pull_request',
            'mcp__github__create_pull_request_review',
            'mcp__github__list_pull_requests',
            'mcp__eslint__lint'
          ],
          agents: {
            'code-quality-analyzer': codeQualityAnalyzerAgent,
            'test-coverage-analyzer': testCoverageAnalyzerAgent,
            'refactoring-suggester': refactoringSuggesterAgent
          },
          mcpServers: mcpServersConfig as any,
          maxTurns: 15,
          permissionMode: 'acceptEdits'
        }
      });

      logger.debug('Processing orchestrator query results');

      // Process the async iterable result
      let finalReport: ReviewReport | null = null;
      let lastError: unknown = null;
      let messages: any[] = [];
      let lastAssistantMessage: string = '';

      for await (const message of result) {
        messages.push(message);

        // Check if this is an assistant message with content
        if (message.type === 'assistant' && message.message) {
          // Extract text from message content
          if (Array.isArray(message.message.content)) {
            for (const block of message.message.content) {
              if (typeof block === 'object' && 'text' in block) {
                lastAssistantMessage = (block as any).text;
                logger.debug('Orchestrator response:', lastAssistantMessage.substring(0, 500));
                break;
              }
            }
          }
        }

        // Check for result messages
        if (message.type === 'result') {
          if (message.subtype === 'success') {
            logger.debug('Successfully completed orchestrator analysis via result message');
            const resultText = message.result || '';
            try {
              const jsonMatch = resultText.match(/\{[\s\S]*\}/);
              if (jsonMatch) {
                const reportData = JSON.parse(jsonMatch[0]);
                const parseResult = ReviewReportSchema.safeParse(reportData);
                if (parseResult.success) {
                  finalReport = parseResult.data;
                }
              }
            } catch (parseError) {
              logger.debug('Failed to parse result message');
            }
          }
          break;
        }
      }

      logger.debug(`Received ${messages.length} total messages from orchestrator`);

      // Log message types
      const messageTypes = messages.map((m: any) => m.type);
      const uniqueTypes = [...new Set(messageTypes)];
      logger.debug('Message types:', uniqueTypes);
      logger.debug('Message type counts:', uniqueTypes.map(t => `${t}: ${messageTypes.filter((m: string) => m === t).length}`));

      // If we didn't get a result message, try to extract JSON from the last assistant message
      if (!finalReport && lastAssistantMessage) {
        logger.debug('Attempting to extract report from final assistant message');
        logger.debug('Final assistant message length:', lastAssistantMessage.length);
        logger.debug('Final assistant message preview:', lastAssistantMessage.substring(0, 1000));
        try {
          const jsonMatch = lastAssistantMessage.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            logger.debug('Found JSON match, length:', jsonMatch[0].length);
            const reportData = JSON.parse(jsonMatch[0]);

            // Attempt to complete missing fields before validation
            const completedReportData = this.completeReportData(reportData);

            const parseResult = ReviewReportSchema.safeParse(completedReportData);
            if (parseResult.success) {
              finalReport = parseResult.data;
              logger.debug('Successfully parsed report from assistant message');
            } else {
              logger.warn('Report validation failed from assistant message', parseResult.error.format());
            }
          } else {
            logger.warn('No JSON found in final assistant message');
          }
        } catch (parseError) {
          logger.warn('Failed to parse report from assistant message', parseError);
        }
      }

      if (!finalReport) {
        logger.warn('No valid report from agents, attempting to generate minimal report');
        // Return a minimal empty report rather than throwing error
        // This allows the system to complete even if agents fail
        finalReport = this.createMinimalReport(owner, repo, prNumber);
      }

      // Add duration metadata
      const duration = Date.now() - startTime;
      finalReport.metadata.duration = duration;
      finalReport.metadata.analyzedAt = new Date().toISOString();

      logger.info(`Code review completed in ${duration}ms`);
      return finalReport;

    } catch (error) {
      logger.error('Orchestrator error:', error);
      throw error;
    }
  }

  /**
   * Completes missing fields in partially-formed report JSON
   * Adds intelligent defaults for fields that subagents may have omitted
   */
  private completeReportData(partialReport: any): any {
    if (!partialReport.fileReviews || partialReport.fileReviews.length === 0) {
      return partialReport;
    }

    const completedFileReviews = partialReport.fileReviews.map((fileReview: any) => {
      // Ensure codeQuality has all required fields
      if (fileReview.codeQuality) {
        fileReview.codeQuality = {
          file: fileReview.file || fileReview.codeQuality.file || 'unknown',
          issues: (fileReview.codeQuality.issues || []).map((issue: any) => ({
            line: issue.line ?? 1,
            severity: issue.severity || 'medium',
            category: issue.category || 'style',
            description: issue.description || 'Issue identified',
            suggestion: issue.suggestion || 'Review and refactor'
          })),
          overallScore: Math.min(100, Math.max(0, fileReview.codeQuality.overallScore ?? 50)),
          summary: fileReview.codeQuality.summary || 'Code quality analysis completed'
        };
      }

      // Ensure testCoverage has all required fields
      if (fileReview.testCoverage) {
        fileReview.testCoverage = {
          file: fileReview.file || fileReview.testCoverage.file || 'unknown',
          hasTests: fileReview.testCoverage.hasTests ?? false,
          testFiles: fileReview.testCoverage.testFiles || [],
          untestedPaths: (fileReview.testCoverage.untestedPaths || []).map((path: any) => ({
            type: path.type || 'function',
            location: path.location || 'unknown',
            priority: path.priority || 'medium',
            reasoning: path.reasoning || 'Test coverage gap identified',
            suggestedTest: path.suggestedTest || 'Add unit tests'
          })),
          coverageEstimate: Math.min(100, Math.max(0, fileReview.testCoverage.coverageEstimate ?? 0)),
          summary: fileReview.testCoverage.summary || 'Test coverage analysis completed'
        };
      }

      // Ensure refactorings has all required fields
      if (fileReview.refactorings) {
        const validRefactoringTypes = ['extract-function', 'rename', 'modernize', 'simplify', 'pattern-improvement'];
        fileReview.refactorings = {
          file: fileReview.file || fileReview.refactorings.file || 'unknown',
          suggestions: (fileReview.refactorings.suggestions || []).map((suggestion: any) => ({
            type: validRefactoringTypes.includes(suggestion.type) ? suggestion.type : 'simplify',
            location: suggestion.location || 'unknown',
            impact: suggestion.impact || 'medium',
            description: suggestion.description || 'Refactoring opportunity identified',
            before: suggestion.before || '// current code',
            after: suggestion.after || '// refactored code',
            benefits: Array.isArray(suggestion.benefits) ? suggestion.benefits.join(', ') : (suggestion.benefits || 'Improved code quality')
          })),
          summary: fileReview.refactorings.summary || 'Refactoring suggestions completed'
        };
      }

      return fileReview;
    });

    // Ensure summary has all required fields
    const completedSummary = partialReport.summary || {};
    const completedRecommendations = (partialReport.recommendations || []).map((rec: any) => ({
      priority: rec.priority || 'medium',
      category: rec.category || 'quality',
      description: rec.description || 'Recommendation',
      files: rec.files || []
    }));

    return {
      pullRequest: partialReport.pullRequest || { owner: 'unknown', repo: 'unknown', number: 0 },
      fileReviews: completedFileReviews,
      summary: {
        totalFiles: completedSummary.totalFiles ?? completedFileReviews.length,
        overallScore: completedSummary.overallScore ?? 60,
        criticalIssues: completedSummary.criticalIssues ?? 0,
        highPriorityTests: completedSummary.highPriorityTests ?? 0,
        refactoringOpportunities: completedSummary.refactoringOpportunities ?? 0
      },
      recommendations: completedRecommendations,
      metadata: partialReport.metadata || {
        analyzedAt: new Date().toISOString(),
        duration: 0,
        agentVersions: {
          'code-quality-analyzer': '1.0.0',
          'test-coverage-analyzer': '1.0.0',
          'refactoring-suggester': '1.0.0'
        }
      }
    };
  }

  private createMinimalReport(
    owner: string,
    repo: string,
    prNumber: number
  ): ReviewReport {
    return {
      pullRequest: { owner, repo, number: prNumber },
      fileReviews: [],
      summary: {
        totalFiles: 0,
        overallScore: 0,
        criticalIssues: 0,
        highPriorityTests: 0,
        refactoringOpportunities: 0
      },
      recommendations: [],
      metadata: {
        analyzedAt: new Date().toISOString(),
        duration: 0,
        agentVersions: {
          'code-quality-analyzer': '1.0.0',
          'test-coverage-analyzer': '1.0.0',
          'refactoring-suggester': '1.0.0'
        }
      }
    };
  }

}
