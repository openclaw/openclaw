import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { TextContent } from "@mariozechner/pi-ai";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { log } from "./logger.js";

/**
 * Maximum share of the context window a single tool result should occupy.
 * This is intentionally conservative – a single tool result should not
 * consume more than 30% of the context window even without other messages.
 */
const MAX_TOOL_RESULT_CONTEXT_SHARE = 0.3;

/**
 * Hard character limit for a single tool result text block.
 * Even for the largest context windows (~2M tokens), a single tool result
 * should not exceed ~400K characters (~100K tokens).
 * This acts as a safety net when we don't know the context window size.
 */
export const HARD_MAX_TOOL_RESULT_CHARS = 400_000;

/**
 * Minimum characters to keep when truncating.
 * We always keep at least the first portion so the model understands
 * what was in the content.
 */
const MIN_KEEP_CHARS = 2_000;

/**
 * Suffix appended to truncated tool results.
 */
const TRUNCATION_SUFFIX =
  "\n\n⚠️ [Content truncated — original was too large for the model's context window. " +
  "The content above is a partial view. If you need more, request specific sections or use " +
  "offset/limit parameters to read smaller chunks.]";

type ToolResultTruncationOptions = {
  suffix?: string;
  minKeepChars?: number;
};

/**
 * Truncate a single text string to fit within maxChars, preserving the beginning.
 */
export function truncateToolResultText(
  text: string,
  maxChars: number,
  options: ToolResultTruncationOptions = {},
): string {
  const suffix = options.suffix ?? TRUNCATION_SUFFIX;
  const minKeepChars = options.minKeepChars ?? MIN_KEEP_CHARS;
  if (text.length <= maxChars) {
    return text;
  }
  const keepChars = Math.max(minKeepChars, maxChars - suffix.length);
  // Try to break at a newline boundary to avoid cutting mid-line
  let cutPoint = keepChars;
  const lastNewline = text.lastIndexOf("\n", keepChars);
  if (lastNewline > keepChars * 0.8) {
    cutPoint = lastNewline;
  }
  return text.slice(0, cutPoint) + suffix;
}

/**
 * Calculate the maximum allowed characters for a single tool result
 * based on the model's context window tokens.
 *
 * Uses a rough 4 chars ≈ 1 token heuristic (conservative for English text;
 * actual ratio varies by tokenizer).
 */
export function calculateMaxToolResultChars(contextWindowTokens: number): number {
  const maxTokens = Math.floor(contextWindowTokens * MAX_TOOL_RESULT_CONTEXT_SHARE);
  // Rough conversion: ~4 chars per token on average
  const maxChars = maxTokens * 4;
  return Math.min(maxChars, HARD_MAX_TOOL_RESULT_CHARS);
}

/**
 * Get the total character count of text content blocks in a tool result message.
 */
export function getToolResultTextLength(msg: AgentMessage): number {
  if (!msg || (msg as { role?: string }).role !== "toolResult") {
    return 0;
  }
  const content = (msg as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return 0;
  }
  let totalLength = 0;
  for (const block of content) {
    if (block && typeof block === "object" && (block as { type?: string }).type === "text") {
      const text = (block as TextContent).text;
      if (typeof text === "string") {
        totalLength += text.length;
      }
    }
  }
  return totalLength;
}

/**
 * Truncate a tool result message's text content blocks to fit within maxChars.
 * Returns a new message (does not mutate the original).
 */
export function truncateToolResultMessage(
  msg: AgentMessage,
  maxChars: number,
  options: ToolResultTruncationOptions = {},
): AgentMessage {
  const suffix = options.suffix ?? TRUNCATION_SUFFIX;
  const minKeepChars = options.minKeepChars ?? MIN_KEEP_CHARS;
  const content = (msg as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return msg;
  }

  // Calculate total text size
  const totalTextChars = getToolResultTextLength(msg);
  if (totalTextChars <= maxChars) {
    return msg;
  }

  // Distribute the budget proportionally among text blocks
  const newContent = content.map((block: unknown) => {
    if (!block || typeof block !== "object" || (block as { type?: string }).type !== "text") {
      return block; // Keep non-text blocks (images) as-is
    }
    const textBlock = block as TextContent;
    if (typeof textBlock.text !== "string") {
      return block;
    }
    // Proportional budget for this block
    const blockShare = textBlock.text.length / totalTextChars;
    const blockBudget = Math.max(minKeepChars + suffix.length, Math.floor(maxChars * blockShare));
    return {
      ...textBlock,
      text: truncateToolResultText(textBlock.text, blockBudget, { suffix, minKeepChars }),
    };
  });

  return { ...msg, content: newContent } as AgentMessage;
}

/**
 * Find oversized tool result entries in a session and truncate them.
 *
 * This operates on the session file by:
 * 1. Opening the session manager
 * 2. Walking the current branch to find oversized tool results
 * 3. Branching from before the first oversized tool result
 * 4. Re-appending all entries from that point with truncated tool results
 *
 * @returns Object indicating whether any truncation was performed
 */
export async function truncateOversizedToolResultsInSession(params: {
  sessionFile: string;
  contextWindowTokens: number;
  sessionId?: string;
  sessionKey?: string;
}): Promise<{ truncated: boolean; truncatedCount: number; reason?: string }> {
  const { sessionFile, contextWindowTokens } = params;
  const maxChars = calculateMaxToolResultChars(contextWindowTokens);

  try {
    const sessionManager = SessionManager.open(sessionFile);
    const branch = sessionManager.getBranch();

    if (branch.length === 0) {
      return { truncated: false, truncatedCount: 0, reason: "empty session" };
    }

    // Find oversized tool result entries and their indices in the branch
    const oversizedIndices: number[] = [];
    for (let i = 0; i < branch.length; i++) {
      const entry = branch[i];
      if (entry.type !== "message") {
        continue;
      }
      const msg = entry.message;
      if ((msg as { role?: string }).role !== "toolResult") {
        continue;
      }
      const textLength = getToolResultTextLength(msg);
      if (textLength > maxChars) {
        oversizedIndices.push(i);
        log.info(
          `[tool-result-truncation] Found oversized tool result: ` +
            `entry=${entry.id} chars=${textLength} maxChars=${maxChars} ` +
            `sessionKey=${params.sessionKey ?? params.sessionId ?? "unknown"}`,
        );
      }
    }

    if (oversizedIndices.length === 0) {
      return { truncated: false, truncatedCount: 0, reason: "no oversized tool results" };
    }

    // Branch from the parent of the first oversized entry
    const firstOversizedIdx = oversizedIndices[0];
    const firstOversizedEntry = branch[firstOversizedIdx];
    const branchFromId = firstOversizedEntry.parentId;

    if (!branchFromId) {
      // The oversized entry is the root - very unusual but handle it
      sessionManager.resetLeaf();
    } else {
      sessionManager.branch(branchFromId);
    }

    // Re-append all entries from the first oversized one onwards,
    // with truncated tool results
    const oversizedSet = new Set(oversizedIndices);
    let truncatedCount = 0;

    for (let i = firstOversizedIdx; i < branch.length; i++) {
      const entry = branch[i];

      if (entry.type === "message") {
        let message = entry.message;

        if (oversizedSet.has(i)) {
          message = truncateToolResultMessage(message, maxChars);
          truncatedCount++;
          const newLength = getToolResultTextLength(message);
          log.info(
            `[tool-result-truncation] Truncated tool result: ` +
              `originalEntry=${entry.id} newChars=${newLength} ` +
              `sessionKey=${params.sessionKey ?? params.sessionId ?? "unknown"}`,
          );
        }

        // appendMessage expects Message | CustomMessage | BashExecutionMessage
        sessionManager.appendMessage(message as Parameters<typeof sessionManager.appendMessage>[0]);
      } else if (entry.type === "compaction") {
        sessionManager.appendCompaction(
          entry.summary,
          entry.firstKeptEntryId,
          entry.tokensBefore,
          entry.details,
          entry.fromHook,
        );
      } else if (entry.type === "thinking_level_change") {
        sessionManager.appendThinkingLevelChange(entry.thinkingLevel);
      } else if (entry.type === "model_change") {
        sessionManager.appendModelChange(entry.provider, entry.modelId);
      } else if (entry.type === "custom") {
        sessionManager.appendCustomEntry(entry.customType, entry.data);
      } else if (entry.type === "custom_message") {
        sessionManager.appendCustomMessageEntry(
          entry.customType,
          entry.content,
          entry.display,
          entry.details,
        );
      } else if (entry.type === "branch_summary") {
        // Branch summaries reference specific entry IDs - skip to avoid inconsistency
        continue;
      } else if (entry.type === "label") {
        // Labels reference specific entry IDs - skip to avoid inconsistency
        continue;
      } else if (entry.type === "session_info") {
        if (entry.name) {
          sessionManager.appendSessionInfo(entry.name);
        }
      }
    }

    log.info(
      `[tool-result-truncation] Truncated ${truncatedCount} tool result(s) in session ` +
        `(contextWindow=${contextWindowTokens} maxChars=${maxChars}) ` +
        `sessionKey=${params.sessionKey ?? params.sessionId ?? "unknown"}`,
    );

    return { truncated: true, truncatedCount };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    log.warn(`[tool-result-truncation] Failed to truncate: ${errMsg}`);
    return { truncated: false, truncatedCount: 0, reason: errMsg };
  }
}

/**
 * Truncate oversized tool results in an array of messages (in-memory).
 * Returns a new array with truncated messages.
 *
 * This is used as a pre-emptive guard before sending messages to the LLM,
 * without modifying the session file.
 */
export function truncateOversizedToolResultsInMessages(
  messages: AgentMessage[],
  contextWindowTokens: number,
): { messages: AgentMessage[]; truncatedCount: number } {
  const maxChars = calculateMaxToolResultChars(contextWindowTokens);
  let truncatedCount = 0;

  const result = messages.map((msg) => {
    if ((msg as { role?: string }).role !== "toolResult") {
      return msg;
    }
    const textLength = getToolResultTextLength(msg);
    if (textLength <= maxChars) {
      return msg;
    }
    truncatedCount++;
    return truncateToolResultMessage(msg, maxChars);
  });

  return { messages: result, truncatedCount };
}

/**
 * Check if a tool result message exceeds the size limit for a given context window.
 */
export function isOversizedToolResult(msg: AgentMessage, contextWindowTokens: number): boolean {
  if ((msg as { role?: string }).role !== "toolResult") {
    return false;
  }
  const maxChars = calculateMaxToolResultChars(contextWindowTokens);
  return getToolResultTextLength(msg) > maxChars;
}

/**
 * Estimate whether the session likely has oversized tool results that caused
 * a context overflow. Used as a heuristic to decide whether to attempt
 * tool result truncation before giving up.
 */
export function sessionLikelyHasOversizedToolResults(params: {
  messages: AgentMessage[];
  contextWindowTokens: number;
}): boolean {
  const { messages, contextWindowTokens } = params;
  const maxChars = calculateMaxToolResultChars(contextWindowTokens);

  for (const msg of messages) {
    if ((msg as { role?: string }).role !== "toolResult") {
      continue;
    }
    const textLength = getToolResultTextLength(msg);
    if (textLength > maxChars) {
      return true;
    }
  }

  return false;
}
