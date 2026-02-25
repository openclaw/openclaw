/**
 * Age-based context compressor — Stage 1 + Stage 2.
 *
 * Stage 1 (tool results):   truncate ToolResultMessage text to maxChars.
 * Stage 2 (assistant text): truncate old AssistantMessage text to
 *                            maxAssistantChars; drop ThinkingContent blocks.
 *
 * Both run as a single pre-pass in streamAssistantResponse, before the
 * user-supplied transformContext hook.
 */
import type { AgentMessage } from "./types.js";

export interface ToolResultCompressionOptions {
  /** How many user-turns from the end to keep uncompressed. Default: 3 */
  ageTurns?: number;
  /** Max characters per tool result before truncation. Default: 200 */
  maxChars?: number;
  /**
   * Max characters per assistant text block before truncation. Default: 500.
   * Set to 0 to skip assistant message compression.
   */
  maxAssistantChars?: number;
}

const COMPRESSION_LABEL = "aged-out";
const CHARS_PER_TOKEN = 4;

/**
 * Rough character count across all message content blocks.
 * Used to measure compression savings (not an exact tokenizer).
 */
export function estimateMessageChars(messages: AgentMessage[]): number {
  let total = 0;
  for (const msg of messages) {
    const content = (msg as { content?: unknown }).content;
    if (typeof content === "string") {
      total += content.length;
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (isTextBlock(block)) {
          total += block.text.length;
        } else {
          // thinking / toolCall / image — use JSON length as a rough estimate
          try {
            total += JSON.stringify(block).length;
          } catch {
            total += 64;
          }
        }
      }
    }
  }
  return total;
}

/** Convert a char estimate to approximate tokens. */
export function charsToTokens(chars: number): number {
  return Math.round(chars / CHARS_PER_TOKEN);
}

function role(msg: AgentMessage): string {
  return (msg as { role?: string }).role ?? "";
}

function isTextBlock(block: unknown): block is { type: "text"; text: string } {
  return !!block && typeof block === "object" && (block as { type?: unknown }).type === "text";
}

function isThinkingBlock(block: unknown): boolean {
  const t = (block as { type?: unknown }).type;
  return t === "thinking" || t === "redactedThinking";
}

function isToolCallBlock(block: unknown): boolean {
  const t = (block as { type?: unknown }).type;
  return t === "toolCall" || t === "tool_use";
}

/** Truncate a list of text blocks to maxChars total, returning a single text block. */
function truncateTextBlocks(
  blocks: { type: "text"; text: string }[],
  maxChars: number,
  label: string,
): { type: "text"; text: string } {
  const full = blocks.map((b) => b.text).join("\n");
  const head = full.slice(0, maxChars);
  const leftover = full.length - head.length;
  return {
    type: "text" as const,
    text: `${head}…[+${leftover} chars, ${label}]`,
  };
}

/**
 * Compresses messages older than `ageTurns` user-turns.
 *
 * - ToolResultMessages: text truncated to maxChars (Stage 1).
 * - AssistantMessages:  text truncated to maxAssistantChars; thinking dropped (Stage 2).
 * - UserMessages: unchanged.
 *
 * Returns a new array; never mutates the originals.
 */
export function compressAgedToolResults(
  messages: AgentMessage[],
  opts: ToolResultCompressionOptions = {},
): AgentMessage[] {
  const ageTurns = opts.ageTurns ?? 3;
  const maxChars = opts.maxChars ?? 200;
  const maxAssistantChars = opts.maxAssistantChars ?? 500;

  // Locate user-message indices (each marks a turn boundary)
  const userIndices: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (role(messages[i]) === "user") {
      userIndices.push(i);
    }
  }

  // Not enough turns to compress anything
  if (userIndices.length <= ageTurns) {
    return messages;
  }

  // Messages before this index are in "old" turns
  const cutoff = userIndices[userIndices.length - ageTurns];

  const result: AgentMessage[] = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const r = role(msg);

    // Recent messages: keep as-is
    if (i >= cutoff) {
      result.push(msg);
      continue;
    }

    // ── Stage 1: tool results ─────────────────────────────────────────────
    if (r === "toolResult") {
      const rawContent = ((msg as { content?: unknown }).content ?? []) as unknown[];
      const textBlocks = rawContent.filter(isTextBlock);
      const totalChars = textBlocks.reduce((sum, b) => sum + b.text.length, 0);

      if (totalChars <= maxChars) {
        result.push(msg);
      } else {
        result.push({
          ...msg,
          content: [truncateTextBlocks(textBlocks, maxChars, COMPRESSION_LABEL)],
        } as AgentMessage);
      }
      continue;
    }

    // ── Stage 2: assistant messages ───────────────────────────────────────
    if (r === "assistant" && maxAssistantChars > 0) {
      const rawContent = ((msg as { content?: unknown }).content ?? []) as unknown[];
      const textBlocks = rawContent.filter(isTextBlock);
      const toolCalls = rawContent.filter(isToolCallBlock);
      const totalTextChars = textBlocks.reduce((sum, b) => sum + b.text.length, 0);

      const needsTruncation = totalTextChars > maxAssistantChars;
      const hasThinking = rawContent.some(isThinkingBlock);

      if (!needsTruncation && !hasThinking) {
        result.push(msg);
        continue;
      }

      // Build compressed content: truncated text + preserved tool calls
      const newContent: unknown[] = [];
      if (textBlocks.length > 0) {
        if (needsTruncation) {
          newContent.push(truncateTextBlocks(textBlocks, maxAssistantChars, COMPRESSION_LABEL));
        } else {
          newContent.push(...textBlocks);
        }
      }
      // Always keep tool call blocks (ToolResultMessages reference them by id)
      newContent.push(...toolCalls);

      result.push({ ...msg, content: newContent } as AgentMessage);
      continue;
    }

    result.push(msg);
  }

  return result;
}
