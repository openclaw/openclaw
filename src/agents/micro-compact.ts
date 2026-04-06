/**
 * Zero-LLM-cost pre-pass that clears old, bulky tool result content before
 * the summarization model ever sees the messages. Only tool types whose
 * results are typically large are targeted; the most recent N results are
 * preserved so the model retains actionable recent context.
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";

/** Tool names whose results tend to be large and stale quickly. */
const CLEARABLE_TOOL_NAMES: ReadonlySet<string> = new Set([
  "read",
  "write",
  "edit",
  "exec",
  "bash",
  "shell",
  "web_search",
  "web_fetch",
  "browser",
]);

export const CLEARED_TOOL_RESULT_PLACEHOLDER = "[Tool output cleared - not recent]";

export const DEFAULT_RECENT_TOOL_RESULTS_PRESERVE = 5;

/**
 * Replace the content of old, clearable tool results with a short placeholder.
 *
 * Scans `messages` for `toolResult` entries whose `toolName` is in the
 * clearable set, then replaces all but the last `recentToolResultsPreserve`
 * of those with a placeholder text block. The message structure (role,
 * toolCallId, toolName, isError, timestamp) is kept intact so downstream
 * pairing logic is unaffected.
 *
 * Error tool results are never cleared — their content is diagnostic.
 */
export function microCompactMessages(
  messages: AgentMessage[],
  recentToolResultsPreserve = DEFAULT_RECENT_TOOL_RESULTS_PRESERVE,
): AgentMessage[] {
  // Collect indices of all clearable, non-error tool results.
  const clearableIndices: number[] = [];
  for (let i = 0; i < messages.length; i += 1) {
    const msg = messages[i];
    if (!msg || typeof msg !== "object") {
      continue;
    }
    const role = (msg as { role?: unknown }).role;
    if (role !== "toolResult") {
      continue;
    }
    const toolResult = msg as {
      toolName?: unknown;
      isError?: unknown;
    };
    // Never clear error results — their content is diagnostic.
    if (toolResult.isError === true) {
      continue;
    }
    const toolName = typeof toolResult.toolName === "string" ? toolResult.toolName : "";
    if (toolName && CLEARABLE_TOOL_NAMES.has(toolName)) {
      clearableIndices.push(i);
    }
  }

  // Protect the most recent N clearable results.
  const protectCount = Math.max(0, recentToolResultsPreserve);
  const clearCount = Math.max(0, clearableIndices.length - protectCount);
  if (clearCount === 0) {
    return messages;
  }
  const indicesToClear = new Set(clearableIndices.slice(0, clearCount));

  return messages.map((msg, i) => {
    if (!indicesToClear.has(i)) {
      return msg;
    }
    return {
      ...msg,
      content: [{ type: "text" as const, text: CLEARED_TOOL_RESULT_PLACEHOLDER }],
    };
  });
}
