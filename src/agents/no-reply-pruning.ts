import type { AgentMessage, AssistantMessage } from "@mariozechner/pi-agent-core";
import { isSilentReplyText, SILENT_REPLY_TOKEN } from "../auto-reply/tokens.js";

/**
 * Check if an assistant message is a NO_REPLY sentinel.
 * Scans all text blocks to handle Gemini-style merged turns.
 */
function isNoReplyMessage(msg: AssistantMessage): boolean {
  const content = msg.content;
  if (!Array.isArray(content) || content.length === 0) {
    return false;
  }
  // Scan all text blocks — Gemini's validateGeminiTurns may merge consecutive
  // assistant turns into a single multi-block message
  for (const block of content) {
    if (block?.type === "text" && isSilentReplyText(block.text, SILENT_REPLY_TOKEN)) {
      return true;
    }
  }
  return false;
}

/**
 * Prune consecutive NO_REPLY assistant messages from the message history,
 * keeping at most `maxConsecutive` in any run of consecutive NO_REPLYs.
 *
 * This prevents the model from learning that "NO_REPLY is always correct"
 * after extended periods of heartbeat-only activity or tool failures.
 *
 * @param messages - The full message history
 * @param maxConsecutive - Maximum consecutive NO_REPLY messages to keep (default: 1)
 * @returns Pruned message array
 *
 * @example
 * // Before: [user] [NO_REPLY] [user] [NO_REPLY] [NO_REPLY] [NO_REPLY] [user]
 * // After:  [user] [NO_REPLY] [user] [NO_REPLY] [user]
 */
export function pruneConsecutiveNoReplies(
  messages: AgentMessage[],
  maxConsecutive: number = 1,
): AgentMessage[] {
  if (messages.length === 0) {
    return messages;
  }

  const result: AgentMessage[] = [];
  let consecutiveNoReplyCount = 0;

  for (const msg of messages) {
    if (msg.role === "assistant" && isNoReplyMessage(msg as AssistantMessage)) {
      consecutiveNoReplyCount++;
      // Only keep up to maxConsecutive NO_REPLY messages in a row
      if (consecutiveNoReplyCount <= maxConsecutive) {
        result.push(msg);
      }
      // Skip this message if we've exceeded the limit
    } else {
      // Not a NO_REPLY message — reset counter and keep the message
      consecutiveNoReplyCount = 0;
      result.push(msg);
    }
  }

  return result;
}

/**
 * Count total NO_REPLY messages and consecutive runs in a message history.
 * Useful for diagnostics.
 */
export function countNoReplies(messages: AgentMessage[]): {
  total: number;
  maxConsecutive: number;
  runs: number;
} {
  let total = 0;
  let maxConsecutive = 0;
  let runs = 0;
  let currentRun = 0;

  for (const msg of messages) {
    if (msg.role === "assistant" && isNoReplyMessage(msg as AssistantMessage)) {
      total++;
      currentRun++;
      if (currentRun === 1) {
        runs++;
      }
      if (currentRun > maxConsecutive) {
        maxConsecutive = currentRun;
      }
    } else {
      currentRun = 0;
    }
  }

  return { total, maxConsecutive, runs };
}
