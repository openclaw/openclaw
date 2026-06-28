/**
 * Pre-compaction pruning: replaces old tool results with compact 1-line
 * summaries before LLM summarization.
 *
 * Three sub-passes:
 *   1. Deduplicate identical tool results (hash-based)
 *   2. Replace old tool results with 1-line summaries
 *   3. Truncate large tool call arguments
 *
 * Ported from Hermes Agent:
 *   agent/context_compressor.py (lines 990-1150, _prune_old_tool_results)
 *
 * Adapted to OpenClaw's AgentMessage type system:
 *   - ToolResultMessage uses { role: "toolResult", toolCallId, toolName, content }
 *   - ToolCall content blocks use { type: "toolCall", id, name, arguments: Record<string, unknown> }
 */

import { createHash } from "node:crypto";
import type { AgentMessage } from "../../../packages/agent-core/src/types.js";

/** Minimum content length (chars) before dedup/summarization applies. */
const MIN_CONTENT_LENGTH = 200;

/** Minimum serialized argument size (chars) before truncation applies. */
const MIN_ARGS_SIZE = 500;

/** Maximum length for truncated string values in arguments. */
const MAX_STRING_VALUE_LENGTH = 200;

/** Head slice length when truncating long strings. */
const TRUNCATION_HEAD = 150;

// -- Types --------------------------------------------------------------------

/** Message with known role and indexable properties, narrowed from AgentMessage. */
type MessageWithRole = AgentMessage & { role: string };

// -- Main Function ------------------------------------------------------------

/**
 * Pre-compaction pruning: replaces old tool result contents with
 * informative 1-line summaries before LLM summarization.
 *
 * @param messages - Messages to prune (will NOT be mutated).
 * @param protectTailCount - Number of recent messages to protect from pruning.
 * @returns A new message array with pruned content, and the count of pruned messages.
 */
export function preCompactionPrune(
  messages: readonly AgentMessage[],
  protectTailCount: number,
): { pruned: AgentMessage[]; prunedCount: number } {
  if (messages.length === 0) {
    return { pruned: [], prunedCount: 0 };
  }

  // Determine the prune boundary: messages before this index are eligible
  const pruneBoundary = Math.max(0, messages.length - Math.max(0, protectTailCount));

  // Work on a shallow copy so we never mutate the input
  let result = [...messages];
  let prunedCount = 0;

  // Sub-pass 1: Deduplicate identical tool results
  const deduped = deduplicateToolResults(result, pruneBoundary);
  prunedCount += deduped.prunedCount;
  result = deduped.messages;

  // Sub-pass 2: Replace old tool results with 1-line summaries
  const summarized = summarizeOldToolResults(result, pruneBoundary);
  prunedCount += summarized.prunedCount;
  result = summarized.messages;

  // Sub-pass 3: Truncate large tool call arguments
  const truncated = truncateToolCallArgs(result, pruneBoundary);
  prunedCount += truncated.prunedCount;
  result = truncated.messages;

  return { pruned: result, prunedCount };
}

// -- Sub-pass 1: Deduplication ------------------------------------------------

function deduplicateToolResults(
  messages: AgentMessage[],
  pruneBoundary: number,
): { messages: AgentMessage[]; prunedCount: number } {
  // Build a map of content hashes -> last seen index (walking forward).
  // The LAST occurrence is the newest copy and should be kept.
  const hashToLastIndex = new Map<string, number>();
  let prunedCount = 0;

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i] as MessageWithRole;
    if (msg.role !== "toolResult") {
      continue;
    }

    const text = extractToolResultText(msg);
    if (text.length < MIN_CONTENT_LENGTH) {
      continue;
    }

    const hash = createHash("sha256").update(text).digest("hex").slice(0, 12);
    hashToLastIndex.set(hash, i);
  }

  // Walk forward; any tool result whose hash has a later occurrence is a dupe
  const result = [...messages];
  for (let i = 0; i < pruneBoundary; i++) {
    const msg = result[i] as MessageWithRole;
    if (msg.role !== "toolResult") {
      continue;
    }

    const text = extractToolResultText(msg);
    if (text.length < MIN_CONTENT_LENGTH) {
      continue;
    }

    const hash = createHash("sha256").update(text).digest("hex").slice(0, 12);
    const lastIdx = hashToLastIndex.get(hash);

    if (lastIdx !== undefined && lastIdx > i) {
      // This is an older duplicate -- replace with placeholder
      result[i] = cloneToolResultWithText(
        msg,
        "[Duplicate tool output -- same content as a more recent call]",
      );
      prunedCount++;
    }
  }

  return { messages: result, prunedCount };
}

// -- Sub-pass 2: Summarization ------------------------------------------------

function summarizeOldToolResults(
  messages: AgentMessage[],
  pruneBoundary: number,
): { messages: AgentMessage[]; prunedCount: number } {
  const result = [...messages];
  let prunedCount = 0;

  for (let i = 0; i < pruneBoundary; i++) {
    const msg = result[i] as MessageWithRole;
    if (msg.role !== "toolResult") {
      continue;
    }

    const text = extractToolResultText(msg);
    if (text.length < MIN_CONTENT_LENGTH) {
      continue;
    }

    const toolName =
      "toolName" in msg ? String((msg as unknown as Record<string, unknown>).toolName) : "unknown";
    const summary = buildToolSummary(toolName, text);

    result[i] = cloneToolResultWithText(msg, summary);
    prunedCount++;
  }

  return { messages: result, prunedCount };
}

function buildToolSummary(toolName: string, text: string): string {
  const charCount = text.length;
  const lineCount = text.split("\n").length;

  switch (toolName) {
    case "Bash": {
      // Try to extract command and exit code from the output
      const cmdMatch = text.match(/^(?:Ran `([^`]+)`|(?:\$\s*)?(.+?)(?:\n|$))/);
      const cmd = cmdMatch?.[1] ?? cmdMatch?.[2] ?? "command";
      const exitMatch = text.match(/exit(?:\s+code)?[:\s]+(\d+)/i);
      const exitCode = exitMatch?.[1] ?? "0";
      return `[Bash] ran \`${cmd.slice(0, 80)}\` -> exit ${exitCode}, ${lineCount} lines`;
    }
    case "Read": {
      const pathMatch = text.match(/(?:read|file)[:\s]+([^\n]+)/i) ?? text.match(/^([^\n]{1,100})/);
      const filePath = pathMatch?.[1]?.trim() ?? "file";
      return `[Read] read ${filePath.slice(0, 80)} (${charCount} chars)`;
    }
    case "Write":
      return `[Write] wrote file (${charCount} chars)`;
    case "Edit":
      return `[Edit] edited file (${charCount} chars)`;
    case "Grep": {
      const patternMatch = text.match(/(?:pattern|search)[:\s]+['"]?([^'"}\n]+)/i);
      const pattern = patternMatch?.[1] ?? "pattern";
      const matchCount = (text.match(/\n/g) ?? []).length;
      return `[Grep] searched for '${pattern.slice(0, 50)}' -> ${matchCount} matches`;
    }
    case "Glob": {
      const patternMatch = text.match(/(?:pattern|glob)[:\s]+['"]?([^'"}\n]+)/i);
      const pattern = patternMatch?.[1] ?? "pattern";
      const resultCount = (text.match(/\n/g) ?? []).length;
      return `[Glob] searched for '${pattern.slice(0, 50)}' -> ${resultCount} results`;
    }
    case "WebFetch":
      return `[WebFetch] fetched content (${charCount} chars)`;
    default:
      return `[${toolName}] (${charCount} chars result)`;
  }
}

// -- Sub-pass 3: Tool Call Argument Truncation ---------------------------------

function truncateToolCallArgs(
  messages: AgentMessage[],
  pruneBoundary: number,
): { messages: AgentMessage[]; prunedCount: number } {
  const result = [...messages];
  let prunedCount = 0;

  for (let i = 0; i < pruneBoundary; i++) {
    const msg = result[i] as MessageWithRole;
    if (msg.role !== "assistant") {
      continue;
    }

    const content =
      "content" in msg && Array.isArray((msg as unknown as Record<string, unknown>).content)
        ? ((msg as unknown as Record<string, unknown>).content as Array<Record<string, unknown>>)
        : null;
    if (!content) {
      continue;
    }

    let modified = false;
    const newContent = content.map((block) => {
      if (block.type !== "toolCall") {
        return block;
      }

      // ToolCall has { type: "toolCall", id, name, arguments: Record<string, unknown> }
      // (NOT toolCallId/toolName -- those are ToolResultMessage fields)
      const args = block.arguments as Record<string, unknown> | undefined;
      if (!args) {
        return block;
      }

      const serialized = JSON.stringify(args);
      if (serialized.length <= MIN_ARGS_SIZE) {
        return block;
      }

      const truncatedArgs = truncateRecordValues(args);
      modified = true;
      return Object.assign({}, block, { arguments: truncatedArgs });
    });

    if (modified) {
      result[i] = { ...msg, content: newContent } as unknown as AgentMessage;
      prunedCount++;
    }
  }

  return { messages: result, prunedCount };
}

/**
 * Walk a Record's values and truncate leaf strings > MAX_STRING_VALUE_LENGTH.
 * Preserves non-string values (numbers, booleans, arrays, nested objects).
 */
function truncateRecordValues(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === "string" && value.length > MAX_STRING_VALUE_LENGTH) {
      result[key] = value.slice(0, TRUNCATION_HEAD) + "...[truncated]";
    } else if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      result[key] = truncateRecordValues(value as Record<string, unknown>);
    } else {
      result[key] = value;
    }
  }
  return result;
}

// -- Helpers ------------------------------------------------------------------

/** Extract text content from a tool result message. */
function extractToolResultText(msg: MessageWithRole): string {
  const content =
    "content" in msg ? (msg as unknown as Record<string, unknown>).content : undefined;
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return (content as Array<Record<string, unknown>>)
      .filter((c) => c.type === "text" && typeof c.text === "string")
      .map((c) => c.text as string)
      .join("\n");
  }
  return "";
}

/** Clone a tool result message with new text content. */
function cloneToolResultWithText(msg: MessageWithRole, text: string): AgentMessage {
  return {
    ...msg,
    content: [{ type: "text" as const, text }],
  } as AgentMessage;
}
