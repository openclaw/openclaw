/**
 * DyDo Orchestrator for Claude Code Sessions
 *
 * DyDo's AI intelligence makes decisions for Claude Code sessions:
 * - Answers questions based on task context
 * - Decides when to continue or wait
 * - Logs commands for bubble display (🐶 DyDo: ...)
 */

import fs from "node:fs";
import { getModel, streamSimple } from "@mariozechner/pi-ai";
import type { Model } from "@mariozechner/pi-ai";
import { createSubsystemLogger } from "../../logging/subsystem.js";

const log = createSubsystemLogger("claude-code/orchestrator");

/** Command log file for bubble display */
const COMMAND_LOG = "/tmp/dydo-commands.jsonl";

/**
 * Context for the orchestrator to make decisions.
 */
export interface OrchestratorContext {
  /** Project name */
  projectName: string;
  /** Working directory */
  workingDir: string;
  /** Resume token */
  resumeToken: string;
  /** Original task/prompt given by user */
  originalTask: string;
  /** Recent actions from Claude Code */
  recentActions: Array<{ icon: string; description: string }>;
  /** Conversation history for context */
  conversationHistory?: string[];
}

/**
 * Log a DyDo command for bubble display.
 */
export function logDyDoCommand(params: {
  prompt: string;
  resumeToken: string;
  short?: string;
  project?: string;
}): void {
  const { prompt, resumeToken, short, project } = params;

  const shortDesc = short ?? (prompt.length > 60 ? `${prompt.slice(0, 60)}...` : prompt);

  const entry = {
    ts: Date.now() / 1000,
    token: resumeToken,
    cmd: prompt,
    short: shortDesc,
    ...(project && { project }),
  };

  try {
    fs.appendFileSync(COMMAND_LOG, JSON.stringify(entry) + "\n");
  } catch (err) {
    log.warn(`Failed to log DyDo command: ${err}`);
  }
}

/**
 * Get latest DyDo command for a token.
 */
export function getLatestDyDoCommand(resumeToken: string): string | undefined {
  if (!fs.existsSync(COMMAND_LOG)) return undefined;

  try {
    const lines = fs.readFileSync(COMMAND_LOG, "utf-8").split("\n").filter(Boolean);
    // Search backwards for matching token
    for (let i = lines.length - 1; i >= 0 && i >= lines.length - 50; i--) {
      try {
        const entry = JSON.parse(lines[i]);
        if (entry.token === resumeToken || resumeToken.startsWith(entry.token)) {
          return entry.short ?? entry.cmd?.slice(0, 60);
        }
      } catch {
        continue;
      }
    }
  } catch (err) {
    log.warn(`Failed to read DyDo commands: ${err}`);
  }

  return undefined;
}

/**
 * Get API key for Anthropic from environment.
 */
function getAnthropicApiKey(): string | undefined {
  // Try OAuth token first (used by Claude Code auth)
  return process.env.ANTHROPIC_OAUTH_TOKEN ?? process.env.ANTHROPIC_API_KEY;
}

/**
 * Generate an intelligent response to Claude Code's question.
 * Uses DyDo's AI to make contextual decisions.
 */
export async function generateOrchestratorResponse(
  context: OrchestratorContext,
  question: string,
): Promise<string> {
  const apiKey = getAnthropicApiKey();
  if (!apiKey) {
    log.warn("No Anthropic API key - falling back to default response");
    return generateFallbackResponse(question);
  }

  try {
    const model = getModel("anthropic", "claude-sonnet-4-20250514") as Model<"anthropic-messages">;

    // Build the orchestrator prompt
    const systemPrompt = buildOrchestratorSystemPrompt(context);
    const userPrompt = buildOrchestratorUserPrompt(context, question);

    log.info(`[orchestrator] Generating response for: ${question.slice(0, 100)}...`);

    const stream = streamSimple(
      model,
      {
        messages: [
          {
            role: "user",
            content: `${systemPrompt}\n\n---\n\n${userPrompt}`,
            timestamp: Date.now(),
          },
        ],
      },
      { apiKey, maxTokens: 500 },
    );

    let response = "";
    for await (const event of stream) {
      if (event.type === "text_delta") {
        response += event.delta;
      }
    }

    response = response.trim();

    // Log the decision for bubble display
    logDyDoCommand({
      prompt: response,
      resumeToken: context.resumeToken,
      short: `Answer: ${response.slice(0, 50)}...`,
      project: context.projectName,
    });

    log.info(`[orchestrator] Generated response: ${response.slice(0, 100)}...`);
    return response;
  } catch (err) {
    log.error(`[orchestrator] AI call failed: ${err}`);
    return generateFallbackResponse(question);
  }
}

/**
 * Build system prompt for orchestrator.
 */
function buildOrchestratorSystemPrompt(context: OrchestratorContext): string {
  return `You are DyDo, an autonomous AI orchestrator managing a Claude Code session.

Your role:
- You are overseeing Claude Code (another AI) working on a software project
- You make decisions on behalf of the user to keep the work moving forward
- You provide clear, actionable guidance to Claude Code

Context:
- Project: ${context.projectName}
- Working directory: ${context.workingDir}
- Original task: ${context.originalTask}

Guidelines for your responses:
1. Be decisive - Claude Code needs clear direction
2. Keep responses concise (1-3 sentences)
3. If asked for confirmation, approve unless there's a clear reason not to
4. If asked for clarification, provide reasonable defaults or best practices
5. If asked about preferences, choose sensible options
6. Focus on completing the original task
7. Trust Claude Code's technical judgment for implementation details

Recent activity:
${context.recentActions.map((a) => `- ${a.icon} ${a.description}`).join("\n") || "- (no recent actions)"}`;
}

/**
 * Build user prompt for orchestrator.
 */
function buildOrchestratorUserPrompt(context: OrchestratorContext, question: string): string {
  return `Claude Code is asking for input. Please provide a response that helps move the task forward.

**Claude Code's question:**
${question}

**Your response** (be concise and decisive):`;
}

/**
 * Generate fallback response when AI is unavailable.
 */
function generateFallbackResponse(question: string): string {
  const lowerQ = question.toLowerCase();

  // Confirmation questions
  if (
    lowerQ.includes("proceed") ||
    lowerQ.includes("continue") ||
    lowerQ.includes("should i") ||
    lowerQ.includes("do you want") ||
    lowerQ.includes("is this ok") ||
    lowerQ.includes("can i") ||
    lowerQ.includes("shall i")
  ) {
    return "Yes, please proceed.";
  }

  // Permission questions
  if (lowerQ.includes("permission") || lowerQ.includes("allow") || lowerQ.includes("approve")) {
    return "Yes, approved.";
  }

  // Choice questions
  if (lowerQ.includes("which") || lowerQ.includes("prefer")) {
    return "Use your best judgment - choose the most common/standard approach.";
  }

  // Default
  return "Use your best judgment and proceed. Make reasonable assumptions if needed.";
}

/**
 * Decide whether to auto-continue when Claude Code goes idle.
 */
export async function shouldAutoContinue(
  context: OrchestratorContext,
  lastMessage: string,
): Promise<{ shouldContinue: boolean; prompt?: string }> {
  // Check if task seems complete
  const lowerMsg = lastMessage.toLowerCase();

  if (
    lowerMsg.includes("complete") ||
    lowerMsg.includes("finished") ||
    lowerMsg.includes("done") ||
    lowerMsg.includes("let me know") ||
    lowerMsg.includes("anything else")
  ) {
    // Task seems done
    return { shouldContinue: false };
  }

  // Task not done - continue
  const continuePrompt = "what about now?";

  logDyDoCommand({
    prompt: continuePrompt,
    resumeToken: context.resumeToken,
    short: "Continue work",
    project: context.projectName,
  });

  return { shouldContinue: true, prompt: continuePrompt };
}
