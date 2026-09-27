/**
 * Estimates message and tool-result character costs for context guards.
 */
import { collectTextContentBlocks } from "../content-blocks.js";
import type { AgentMessage } from "../runtime/index.js";
import {
  BRANCH_SUMMARY_PREFIX,
  BRANCH_SUMMARY_SUFFIX,
  COMPACTION_SUMMARY_PREFIX,
  COMPACTION_SUMMARY_SUFFIX,
  bashExecutionToText,
} from "../runtime/index.js";
import { isToolResultTextBlock, prepareToolResultTextChars } from "./tool-result-text-budget.js";

export const TOOL_RESULT_CHARS_PER_TOKEN_ESTIMATE = 2;
const IMAGE_CHAR_ESTIMATE = 8_000;
export const TOOL_IMAGE_CHARS = IMAGE_CHAR_ESTIMATE * TOOL_RESULT_CHARS_PER_TOKEN_ESTIMATE;

export type MessageCharEstimateCache = WeakMap<AgentMessage, number>;

function isImageBlock(block: unknown): boolean {
  return (
    Boolean(block) && typeof block === "object" && (block as { type?: unknown }).type === "image"
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

function estimateContentBlockChars(content: unknown[], toolResult = false): number {
  const weight = toolResult ? TOOL_RESULT_CHARS_PER_TOKEN_ESTIMATE : 1;
  let chars = 0;
  for (const block of content) {
    if (isToolResultTextBlock(block) && block.type === "text") {
      chars += toolResult
        ? prepareToolResultTextChars(block, block.text, weight)
        : block.text.length;
    } else if (isImageBlock(block)) {
      chars += IMAGE_CHAR_ESTIMATE * weight;
    } else {
      chars += estimateUnknownChars(block) * weight;
    }
  }
  return chars;
}

export function getToolResultText(msg: AgentMessage): string {
  return collectTextContentBlocks(getToolResultContent(msg)).join("\n");
}

export function estimateMessageChars(msg: AgentMessage, contentOverride?: unknown[]): number {
  if (
    !msg ||
    typeof msg !== "object" ||
    ("excludeFromContext" in msg && msg.excludeFromContext === true)
  ) {
    return 0;
  }

  if (msg.role === "user") {
    const content = contentOverride ?? msg.content;
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
    const content = contentOverride ?? (msg as { content?: unknown }).content;
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
    const content = contentOverride ?? getToolResultContent(msg);
    return estimateContentBlockChars(content, true);
  }

  const role: unknown = Reflect.get(msg, "role");

  if (role === "bashExecution") {
    return bashExecutionToText(msg as Parameters<typeof bashExecutionToText>[0]).length;
  }

  if (role === "branchSummary") {
    const rawSummary = Reflect.get(msg, "summary");
    const summary = typeof rawSummary === "string" ? rawSummary : "";
    return (BRANCH_SUMMARY_PREFIX + summary + BRANCH_SUMMARY_SUFFIX).length;
  }

  if (role === "compactionSummary") {
    const rawSummary = Reflect.get(msg, "summary");
    const summary = typeof rawSummary === "string" ? rawSummary : "";
    return (COMPACTION_SUMMARY_PREFIX + summary + COMPACTION_SUMMARY_SUFFIX).length;
  }

  if (role === "custom") {
    const content = contentOverride ?? Reflect.get(msg, "content");
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
