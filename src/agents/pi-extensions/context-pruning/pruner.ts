import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ImageContent, TextContent, ToolResultMessage } from "@mariozechner/pi-ai";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { EffectiveContextPruningSettings } from "./settings.js";
import { makeToolPrunablePredicate } from "./tools.js";

/**
 * Characters per token estimation constant.
 * Based on typical tokenization where 1 token ≈ 4 characters for English text.
 * This is a conservative estimate that works across different tokenizers (Claude, GPT, etc.).
 * @see https://help.openai.com/en/articles/4936856-what-are-tokens-and-how-to-count-them
 */
const CHARS_PER_TOKEN_ESTIMATE = 4;

/**
 * Estimated character count for image content blocks.
 * We currently skip pruning tool results that contain images since these are often
 * directly relevant and hard to partially prune safely. However, we count them
 * approximately so we start trimming prunable tool results earlier when image-heavy
 * context is consuming the window.
 */
const IMAGE_CHAR_ESTIMATE = 8_000;

/**
 * Minimum valid characters for a soft trim operation to be considered useful.
 * Prevents trimming operations that would result in negligible space savings.
 */
const MIN_TRIM_CHARS = 10;

/**
 * Maximum allowed ratio for soft trim (head + tail) relative to original content.
 * Prevents cases where headChars + tailChars >= rawLen would result in no actual trimming.
 */
const MAX_TRIM_RATIO = 0.95;

/**
 * Creates a text content block from a string.
 * @param text - The text content
 * @returns A TextContent object with type "text"
 */
function asText(text: string): TextContent {
  return { type: "text", text };
}

/**
 * Validates soft trim settings to ensure they are reasonable.
 * Prevents edge cases where headChars or tailChars are negative, NaN, or Infinity.
 * @param settings - The soft trim settings to validate
 * @returns Validated settings with safe defaults applied
 */
function validateSoftTrimSettings(settings: EffectiveContextPruningSettings["softTrim"]): {
  headChars: number;
  tailChars: number;
  maxChars: number;
} {
  const safeMaxChars =
    Number.isFinite(settings.maxChars) && settings.maxChars > MIN_TRIM_CHARS
      ? settings.maxChars
      : 0;

  const safeHeadChars =
    Number.isFinite(settings.headChars) && settings.headChars >= 0 ? settings.headChars : 0;

  const safeTailChars =
    Number.isFinite(settings.tailChars) && settings.tailChars >= 0 ? settings.tailChars : 0;

  return { headChars: safeHeadChars, tailChars: safeTailChars, maxChars: safeMaxChars };
}

/**
 * Calculates the effective window size with safety bounds.
 * Handles edge cases like NaN, Infinity, zero, or negative values.
 * @param contextWindowTokens - The raw context window size in tokens
 * @returns Safe character window size, or null if invalid
 */
function calculateCharWindow(contextWindowTokens: number): number | null {
  if (!Number.isFinite(contextWindowTokens) || contextWindowTokens <= 0) {
    return null;
  }
  const charWindow = contextWindowTokens * CHARS_PER_TOKEN_ESTIMATE;
  return Number.isFinite(charWindow) && charWindow > 0 ? charWindow : null;
}

/**
 * Extracts all text segments from a content array.
 * Filters out non-text blocks (images) and returns an array of text strings.
 *
 * @param content - Array of content blocks (text or image)
 * @returns Array of text strings from text blocks only
 */
function collectTextSegments(content: ReadonlyArray<TextContent | ImageContent>): string[] {
  if (!Array.isArray(content) || content.length === 0) {
    return [];
  }

  const parts: string[] = [];
  for (const block of content) {
    if (block?.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    }
  }
  return parts;
}

function estimateJoinedTextLength(parts: string[]): number {
  if (parts.length === 0) {
    return 0;
  }
  let len = 0;
  for (const p of parts) {
    len += p.length;
  }
  // Joined with "\n" separators between blocks.
  len += Math.max(0, parts.length - 1);
  return len;
}

function takeHeadFromJoinedText(parts: string[], maxChars: number): string {
  if (maxChars <= 0 || parts.length === 0) {
    return "";
  }
  let remaining = maxChars;
  let out = "";
  for (let i = 0; i < parts.length && remaining > 0; i++) {
    if (i > 0) {
      out += "\n";
      remaining -= 1;
      if (remaining <= 0) {
        break;
      }
    }
    const p = parts[i];
    if (p.length <= remaining) {
      out += p;
      remaining -= p.length;
    } else {
      out += p.slice(0, remaining);
      remaining = 0;
    }
  }
  return out;
}

function takeTailFromJoinedText(parts: string[], maxChars: number): string {
  if (maxChars <= 0 || parts.length === 0) {
    return "";
  }
  let remaining = maxChars;
  const out: string[] = [];
  for (let i = parts.length - 1; i >= 0 && remaining > 0; i--) {
    const p = parts[i];
    if (p.length <= remaining) {
      out.push(p);
      remaining -= p.length;
    } else {
      out.push(p.slice(p.length - remaining));
      remaining = 0;
      break;
    }
    if (remaining > 0 && i > 0) {
      out.push("\n");
      remaining -= 1;
    }
  }
  out.reverse();
  return out.join("");
}

function hasImageBlocks(content: ReadonlyArray<TextContent | ImageContent>): boolean {
  for (const block of content) {
    if (block.type === "image") {
      return true;
    }
  }
  return false;
}

/**
 * Safely gets the string length with null/undefined handling.
 * @param value - The string to measure
 * @returns The length, or 0 if null/undefined/not a string
 */
function safeStringLength(value: unknown): number {
  return typeof value === "string" ? value.length : 0;
}

/**
 * Safely stringifies an object for size estimation.
 * Falls back to a default size if JSON.stringify fails (circular references, etc.)
 *
 * @param value - The value to stringify
 * @param fallbackLength - Length to use if stringify fails (default: 128)
 * @returns Estimated character count
 */
function safeJsonEstimate(value: unknown, fallbackLength = 128): number {
  try {
    return JSON.stringify(value ?? {}).length;
  } catch {
    return fallbackLength;
  }
}

/**
 * Estimates the character count of a message for context window management.
 * Uses different logic based on message role (user, assistant, toolResult).
 *
 * Edge cases handled:
 * - Null/undefined content blocks are skipped
 * - Invalid content types return safe defaults
 * - Circular references in tool arguments are caught
 *
 * @param message - The agent message to estimate
 * @returns Estimated character count
 */
function estimateMessageChars(message: AgentMessage): number {
  // Validate message structure
  if (!message || typeof message !== "object") {
    return 256; // Safe default for invalid messages
  }

  if (message.role === "user") {
    const content = message.content;
    if (typeof content === "string") {
      return content.length;
    }
    if (!Array.isArray(content)) {
      return 256;
    }
    let chars = 0;
    for (const b of content) {
      if (!b || typeof b !== "object") {
        continue;
      }
      if (b.type === "text" && typeof b.text === "string") {
        chars += b.text.length;
      }
      if (b.type === "image") {
        chars += IMAGE_CHAR_ESTIMATE;
      }
    }
    return chars;
  }

  if (message.role === "assistant") {
    if (!Array.isArray(message.content)) {
      return 256;
    }
    let chars = 0;
    for (const b of message.content) {
      if (!b || typeof b !== "object") {
        continue;
      }
      if (b.type === "text") {
        chars += safeStringLength(b.text);
      }
      if (b.type === "thinking") {
        chars += safeStringLength(b.thinking);
      }
      if (b.type === "toolCall") {
        chars += safeJsonEstimate(b.arguments, 128);
      }
    }
    return chars;
  }

  if (message.role === "toolResult") {
    if (!Array.isArray(message.content)) {
      return 256;
    }
    let chars = 0;
    for (const b of message.content) {
      if (!b || typeof b !== "object") {
        continue;
      }
      if (b.type === "text") {
        chars += safeStringLength(b.text);
      }
      if (b.type === "image") {
        chars += IMAGE_CHAR_ESTIMATE;
      }
    }
    return chars;
  }

  // Unknown role - return safe default
  return 256;
}

function estimateContextChars(messages: AgentMessage[]): number {
  return messages.reduce((sum, m) => sum + estimateMessageChars(m), 0);
}

function findAssistantCutoffIndex(
  messages: AgentMessage[],
  keepLastAssistants: number,
): number | null {
  // keepLastAssistants <= 0 => everything is potentially prunable.
  if (keepLastAssistants <= 0) {
    return messages.length;
  }

  let remaining = keepLastAssistants;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role !== "assistant") {
      continue;
    }
    remaining--;
    if (remaining === 0) {
      return i;
    }
  }

  // Not enough assistant messages to establish a protected tail.
  return null;
}

function findFirstUserIndex(messages: AgentMessage[]): number | null {
  for (let i = 0; i < messages.length; i++) {
    if (messages[i]?.role === "user") {
      return i;
    }
  }
  return null;
}

/**
 * Performs a "soft trim" on a tool result message, keeping the head and tail
 * while truncating the middle content. This preserves context about what
 * happened at the start and end of a tool execution while reducing token usage.
 *
 * Edge cases handled:
 * - Messages with images are skipped (can't safely trim binary content)
 * - Empty or very short content is not modified
 * - Invalid settings are clamped to safe values
 * - Cases where head + tail >= original length are rejected (no savings)
 *
 * @param params - Object containing the message and settings
 * @returns Trimmed message, or null if no trimming was performed
 */
function softTrimToolResultMessage(params: {
  msg: ToolResultMessage;
  settings: EffectiveContextPruningSettings;
}): ToolResultMessage | null {
  const { msg, settings } = params;

  // Validate message structure
  if (!msg || typeof msg !== "object" || !Array.isArray(msg.content)) {
    return null;
  }

  // Ignore image tool results for now: these are often directly relevant and hard to partially prune safely.
  if (hasImageBlocks(msg.content)) {
    return null;
  }

  const parts = collectTextSegments(msg.content);
  // No text content to trim
  if (parts.length === 0) {
    return null;
  }

  const rawLen = estimateJoinedTextLength(parts);

  // Validate soft trim settings
  const softTrim = validateSoftTrimSettings(settings.softTrim);

  // Content is already small enough, no trimming needed
  if (rawLen <= softTrim.maxChars) {
    return null;
  }

  // Would trimming actually save space? If head + tail covers most of the content, skip.
  const effectiveTrimChars = softTrim.headChars + softTrim.tailChars;
  if (effectiveTrimChars >= rawLen * MAX_TRIM_RATIO) {
    return null;
  }

  // Ensure we keep at least some meaningful content
  if (effectiveTrimChars < MIN_TRIM_CHARS) {
    return null;
  }

  const head = takeHeadFromJoinedText(parts, softTrim.headChars);
  const tail = takeTailFromJoinedText(parts, softTrim.tailChars);

  // Edge case: head or tail extraction failed
  if (head === "" && tail === "") {
    return null;
  }

  const trimmed = head && tail ? `${head}\n...\n${tail}` : head || tail || "...";

  const note = `

[Tool result trimmed: kept first ${softTrim.headChars} chars and last ${softTrim.tailChars} chars of ${rawLen} chars.]`;

  return { ...msg, content: [asText(trimmed + note)] };
}

/**
 * Prunes context messages to fit within the model's context window.
 * Implements a two-phase pruning strategy:
 *
 * Phase 1 - Soft Trim: Truncates individual tool result messages by keeping head and tail,
 *          removing middle content. Preserves context while reducing size.
 *
 * Phase 2 - Hard Clear: Completely replaces prunable tool results with a placeholder.
 *          Used when soft trimming isn't enough to get under the limit.
 *
 * Safety mechanisms:
 * - Never prunes messages before the first user message (protects identity/context reads)
 * - Respects keepLastAssistants setting to preserve recent assistant responses
 * - Skips tool results containing images
 * - Validates all numeric parameters to prevent NaN/Infinity issues
 *
 * @param params - Pruning parameters including messages, settings, and context
 * @returns Potentially pruned message array
 */
export function pruneContextMessages(params: {
  messages: AgentMessage[];
  settings: EffectiveContextPruningSettings;
  ctx: Pick<ExtensionContext, "model">;
  isToolPrunable?: (toolName: string) => boolean;
  contextWindowTokensOverride?: number;
}): AgentMessage[] {
  const { messages, settings, ctx } = params;

  // Validate messages array
  if (!Array.isArray(messages) || messages.length === 0) {
    return messages;
  }

  // Determine effective context window with priority: override > model config
  const contextWindowTokens =
    typeof params.contextWindowTokensOverride === "number" &&
    Number.isFinite(params.contextWindowTokensOverride) &&
    params.contextWindowTokensOverride > 0
      ? params.contextWindowTokensOverride
      : ctx.model?.contextWindow;

  if (!contextWindowTokens || !Number.isFinite(contextWindowTokens) || contextWindowTokens <= 0) {
    return messages;
  }

  const charWindow = calculateCharWindow(contextWindowTokens);
  if (charWindow === null) {
    return messages;
  }

  const cutoffIndex = findAssistantCutoffIndex(messages, settings.keepLastAssistants);
  if (cutoffIndex === null) {
    return messages;
  }

  // Bootstrap safety: never prune anything before the first user message. This protects initial
  // "identity" reads (SOUL.md, USER.md, etc.) which typically happen before the first inbound user
  // message exists in the session transcript.
  const firstUserIndex = findFirstUserIndex(messages);
  const pruneStartIndex = firstUserIndex === null ? messages.length : firstUserIndex;

  const isToolPrunable = params.isToolPrunable ?? makeToolPrunablePredicate(settings.tools);

  const totalCharsBefore = estimateContextChars(messages);
  let totalChars = totalCharsBefore;
  let ratio = totalChars / charWindow;
  if (ratio < settings.softTrimRatio) {
    return messages;
  }

  const prunableToolIndexes: number[] = [];
  let next: AgentMessage[] | null = null;

  for (let i = pruneStartIndex; i < cutoffIndex; i++) {
    const msg = messages[i];
    if (!msg || msg.role !== "toolResult") {
      continue;
    }
    if (!isToolPrunable(msg.toolName)) {
      continue;
    }
    if (hasImageBlocks(msg.content)) {
      continue;
    }
    prunableToolIndexes.push(i);

    const updated = softTrimToolResultMessage({
      msg: msg as unknown as ToolResultMessage,
      settings,
    });
    if (!updated) {
      continue;
    }

    const beforeChars = estimateMessageChars(msg);
    const afterChars = estimateMessageChars(updated as unknown as AgentMessage);
    totalChars += afterChars - beforeChars;
    if (!next) {
      next = messages.slice();
    }
    next[i] = updated as unknown as AgentMessage;
  }

  const outputAfterSoftTrim = next ?? messages;
  ratio = totalChars / charWindow;
  if (ratio < settings.hardClearRatio) {
    return outputAfterSoftTrim;
  }
  if (!settings.hardClear.enabled) {
    return outputAfterSoftTrim;
  }

  let prunableToolChars = 0;
  for (const i of prunableToolIndexes) {
    const msg = outputAfterSoftTrim[i];
    if (!msg || msg.role !== "toolResult") {
      continue;
    }
    prunableToolChars += estimateMessageChars(msg);
  }
  if (prunableToolChars < settings.minPrunableToolChars) {
    return outputAfterSoftTrim;
  }

  for (const i of prunableToolIndexes) {
    if (ratio < settings.hardClearRatio) {
      break;
    }
    const msg = (next ?? messages)[i];
    if (!msg || msg.role !== "toolResult") {
      continue;
    }

    const beforeChars = estimateMessageChars(msg);
    const cleared: ToolResultMessage = {
      ...msg,
      content: [asText(settings.hardClear.placeholder)],
    };
    if (!next) {
      next = messages.slice();
    }
    next[i] = cleared as unknown as AgentMessage;
    const afterChars = estimateMessageChars(cleared as unknown as AgentMessage);
    totalChars += afterChars - beforeChars;
    ratio = totalChars / charWindow;
  }

  return next ?? messages;
}
