/**
 * Estimates message and tool-result character costs for context guards.
 */
import type { AgentMessage } from "../runtime/index.js";
import {
  BRANCH_SUMMARY_PREFIX,
  BRANCH_SUMMARY_SUFFIX,
  COMPACTION_SUMMARY_PREFIX,
  COMPACTION_SUMMARY_SUFFIX,
  bashExecutionToText,
} from "../runtime/index.js";
import { estimateToolResultTextChars } from "./tool-result-text-budget.js";

export const TOOL_RESULT_CHARS_PER_TOKEN_ESTIMATE = 2;
const IMAGE_CHAR_ESTIMATE = 8_000;
const VISUAL_CHARS_PER_TOKEN_ESTIMATE = 4;
const VIDEO_BYTES_PER_TOKEN = 512;
const MAX_VIDEO_CHAR_ESTIMATE = 32_768 * VISUAL_CHARS_PER_TOKEN_ESTIMATE;

export type MessageCharEstimateCache = WeakMap<AgentMessage, number>;

function isTextBlock(block: unknown): block is { type: "text"; text: string } {
  return (
    Boolean(block) &&
    typeof block === "object" &&
    (block as { type?: unknown }).type === "text" &&
    typeof (block as { text?: unknown }).text === "string"
  );
}

function estimateVisualBlockChars(block: unknown): number | undefined {
  if (!block || typeof block !== "object") {
    return undefined;
  }
  const visual = block as { type?: unknown; data?: unknown };
  if (visual.type === "image") {
    return IMAGE_CHAR_ESTIMATE;
  }
  if (visual.type !== "video") {
    return undefined;
  }
  const data = typeof visual.data === "string" ? visual.data : "";
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  const decodedBytes = Math.max(0, Math.floor((data.length * 3) / 4) - padding);
  // Visual providers tokenize sampled frames, never the opaque base64 transport payload.
  return Math.min(
    MAX_VIDEO_CHAR_ESTIMATE,
    Math.max(
      IMAGE_CHAR_ESTIMATE,
      Math.ceil(decodedBytes / VIDEO_BYTES_PER_TOKEN) * VISUAL_CHARS_PER_TOKEN_ESTIMATE,
    ),
  );
}

function estimateUnknownChars(value: unknown): number {
  if (typeof value === "string") {
    return value.length;
  }
  if (value === undefined) {
    return 0;
  }
  try {
    const serialized = JSON.stringify(value);
    return typeof serialized === "string" ? serialized.length : 0;
  } catch {
    return 256;
  }
}

export function isToolResultMessage(msg: AgentMessage): boolean {
  const role = (msg as { role?: unknown }).role;
  const type = (msg as { type?: unknown }).type;
  return role === "toolResult" || role === "tool" || type === "toolResult";
}

function getToolResultContent(msg: AgentMessage): unknown[] {
  if (!isToolResultMessage(msg)) {
    return [];
  }
  const content = (msg as { content?: unknown }).content;
  if (typeof content === "string") {
    return [{ type: "text", text: content }];
  }
  return Array.isArray(content) ? content : [];
}

function estimateContentBlockChars(content: unknown[]): number {
  let chars = 0;
  for (const block of content) {
    if (isTextBlock(block)) {
      chars += block.text.length;
    } else {
      chars += estimateVisualBlockChars(block) ?? estimateUnknownChars(block);
    }
  }
  return chars;
}

function estimateToolResultContentChars(content: unknown[]): number {
  let chars = 0;
  for (const block of content) {
    if (isTextBlock(block)) {
      chars += estimateToolResultTextChars(block.text, {
        minimumRawWeight: TOOL_RESULT_CHARS_PER_TOKEN_ESTIMATE,
      });
    } else {
      const visualChars = estimateVisualBlockChars(block);
      if (visualChars === undefined) {
        chars += estimateUnknownChars(block) * TOOL_RESULT_CHARS_PER_TOKEN_ESTIMATE;
      } else if ((block as { type: string }).type === "video") {
        // Convert visual-frame tokens into this guard's budget instead of multiplying
        // transport bytes or dropping a valid large video from a 128K-token context.
        chars += Math.max(
          IMAGE_CHAR_ESTIMATE * TOOL_RESULT_CHARS_PER_TOKEN_ESTIMATE,
          Math.ceil(
            (visualChars * TOOL_RESULT_CHARS_PER_TOKEN_ESTIMATE) / VISUAL_CHARS_PER_TOKEN_ESTIMATE,
          ),
        );
      } else {
        chars += visualChars * TOOL_RESULT_CHARS_PER_TOKEN_ESTIMATE;
      }
    }
  }
  return chars;
}

export function getToolResultText(msg: AgentMessage): string {
  const content = getToolResultContent(msg);
  const chunks: string[] = [];
  for (const block of content) {
    if (isTextBlock(block)) {
      chunks.push(block.text);
    }
  }
  return chunks.join("\n");
}

function estimateMessageChars(msg: AgentMessage): number {
  if (!msg || typeof msg !== "object") {
    return 0;
  }

  if (msg.role === "user") {
    const content = msg.content;
    if (typeof content === "string") {
      return content.length;
    }
    if (Array.isArray(content)) {
      return estimateContentBlockChars(content);
    }
    return 0;
  }

  if (msg.role === "assistant") {
    let chars = 0;
    const content = (msg as { content?: unknown }).content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (!block || typeof block !== "object") {
          continue;
        }
        const typed = block as {
          type?: unknown;
          text?: unknown;
          thinking?: unknown;
          arguments?: unknown;
        };
        if (typed.type === "text" && typeof typed.text === "string") {
          chars += typed.text.length;
        } else if (typed.type === "thinking" && typeof typed.thinking === "string") {
          chars += typed.thinking.length;
        } else if (typed.type === "toolCall") {
          try {
            chars += JSON.stringify(typed.arguments ?? {}).length;
          } catch {
            chars += 128;
          }
        } else {
          chars += estimateUnknownChars(block);
        }
      }
    }
    return chars;
  }

  if (isToolResultMessage(msg)) {
    // `details` is stripped before provider conversion; estimate only visible content.
    const content = getToolResultContent(msg);
    return estimateToolResultContentChars(content);
  }

  const record = msg as unknown as Record<string, unknown>;

  if (record.role === "bashExecution") {
    if (record.excludeFromContext === true) {
      return 0;
    }
    return bashExecutionToText(msg as unknown as Parameters<typeof bashExecutionToText>[0]).length;
  }

  if (record.role === "branchSummary") {
    const summary = typeof record.summary === "string" ? record.summary : "";
    return (BRANCH_SUMMARY_PREFIX + summary + BRANCH_SUMMARY_SUFFIX).length;
  }

  if (record.role === "compactionSummary") {
    const summary = typeof record.summary === "string" ? record.summary : "";
    return (COMPACTION_SUMMARY_PREFIX + summary + COMPACTION_SUMMARY_SUFFIX).length;
  }

  if (record.role === "custom") {
    const content = record.content;
    if (typeof content === "string") {
      return content.length;
    }
    if (Array.isArray(content)) {
      return estimateContentBlockChars(content);
    }
    return 0;
  }

  return 256;
}

export function createMessageCharEstimateCache(): MessageCharEstimateCache {
  return new WeakMap<AgentMessage, number>();
}

export function estimateMessageCharsCached(
  msg: AgentMessage,
  cache: MessageCharEstimateCache,
): number {
  const hit = cache.get(msg);
  if (hit !== undefined) {
    return hit;
  }
  const estimated = estimateMessageChars(msg);
  cache.set(msg, estimated);
  return estimated;
}
