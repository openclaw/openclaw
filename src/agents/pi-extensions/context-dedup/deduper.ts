/* eslint-disable @typescript-eslint/no-explicit-any */
import { createHash } from "node:crypto";

export type RefTagFormat = "unicode" | "angle";

/** Message structure from context event */
export interface DedupMessage {
  role: "user" | "assistant" | "system" | "tool" | "toolResult";
  content: string | { type: string; text?: string; content?: string }[];
}

export interface DedupConfig {
  mode: "off" | "on";
  debugDump?: boolean;
  minContentSize: number;
  refTagFormat: RefTagFormat;
}

export interface EffectiveDedupSettings {
  mode: "off" | "on";
  debugDump?: boolean;
  minContentSize: number;
  refTagFormat: RefTagFormat;
}

export interface DedupResult {
  messages: any[];
}

export interface DedupOptions {
  /**
   * Message indexes that must remain fully expanded (no pointer replacement).
   * Used to avoid nested compaction when read-lineage notes point at these messages.
   */
  protectedMessageIndexes?: Set<number>;
}

/**
 * Generate a short hash for content (8 hex chars).
 */
export function contentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 8);
}

function messageRole(msg: any): string {
  return String(msg?.role ?? "").toLowerCase();
}

/**
 * Dedup target scope:
 * - user / assistant / tool / toolResult message text blocks
 * - excludes system messages to avoid touching instructions
 * - no sub-line/LCS chunking; exact full-string matches only
 */
function isDedupEligibleMessage(msg: any): boolean {
  const role = messageRole(msg);
  return role === "user" || role === "assistant" || role === "tool" || role === "toolresult";
}

type TextLikeBlock =
  | string
  | {
      type?: string;
      text?: string;
      content?: string;
      parts?: unknown[];
      [key: string]: unknown;
    };

function extractTextValue(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value)) {
    const parts = value
      .map((part) => extractTextValue(part))
      .filter((part): part is string => typeof part === "string" && part.length > 0);

    if (parts.length === 0) {
      return undefined;
    }

    return parts.join("\n");
  }

  if (!value || typeof value !== "object") {
    return undefined;
  }

  const obj = value as { text?: unknown; content?: unknown; parts?: unknown[] };

  if (typeof obj.text === "string") {
    return obj.text;
  }

  if (typeof obj.content === "string") {
    return obj.content;
  }

  if (Array.isArray(obj.parts)) {
    return extractTextValue(obj.parts);
  }

  return undefined;
}

function getBlockText(block: TextLikeBlock): string | undefined {
  if (typeof block === "string") {
    return block;
  }

  if (!block || typeof block !== "object") {
    return undefined;
  }

  const blockType = typeof block.type === "string" ? block.type.toLowerCase() : undefined;
  if (blockType && blockType !== "text") {
    return undefined;
  }

  return extractTextValue(block);
}

function replaceBlockText(block: TextLikeBlock, nextText: string): TextLikeBlock {
  if (typeof block === "string") {
    return nextText;
  }

  if (!block || typeof block !== "object") {
    return block;
  }

  if (typeof block.text === "string") {
    return { ...block, text: nextText };
  }

  if (typeof block.content === "string") {
    return { ...block, content: nextText };
  }

  if (Array.isArray(block.parts)) {
    return {
      ...block,
      parts: [{ type: "text", text: nextText }],
    };
  }

  return block;
}

function stripLeadingTimestampPrefix(text: string): string {
  const patterns = [
    /^\[[A-Za-z]{3}\s+\d{4}-\d{2}-\d{2}\s+\d{1,2}:\d{2}(?::\d{2})?\s+[A-Za-z_/+-]{2,12}\]\s*/,
    /^\[\d{4}-\d{2}-\d{2}[ T]\d{1,2}:\d{2}(?::\d{2})?(?:\s+[A-Za-z_/+-]{2,12})?\]\s*/,
  ];

  let normalized = text;
  for (const pattern of patterns) {
    normalized = normalized.replace(pattern, "");
  }
  return normalized;
}

function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

function normalizeTrailingNewlines(text: string): string {
  return text.replace(/\n+$/g, "");
}

function normalizeTextForDedup(text: string, role: string): string {
  let normalized = normalizeLineEndings(text);

  if (role === "user" || role === "assistant") {
    normalized = stripLeadingTimestampPrefix(normalized);
  }

  // Tool/read payloads that are otherwise identical can differ only by terminal
  // newline count; normalize this so obvious repeats still dedup.
  normalized = normalizeTrailingNewlines(normalized);

  return normalized;
}

/**
 * Deduplicate content in messages.
 *
 * Algorithm:
 * 1. Scan eligible message text blocks for exact duplicate strings
 * 2. Keep the first occurrence intact
 * 3. Replace later occurrences with a plain-language pointer to the first one
 *
 * Notes:
 * - This intentionally avoids symbolic ref-table tags and only emits plain-language pointers.
 */
export function deduplicateMessages(
  messages: any[],
  config: DedupConfig,
  options: DedupOptions = {},
): DedupResult {
  if (config.mode === "off") {
    return {
      messages,
    };
  }

  const protectedMessageIndexes = options.protectedMessageIndexes ?? new Set<number>();

  type FirstOccurrence = {
    text: string;
    canonicalText: string;
    messageIndex: number;
    blockIndex: number;
    toolCallId?: string;
  };

  const countsByCanonicalText = new Map<string, number>();
  const firstByCanonicalText = new Map<string, FirstOccurrence>();

  for (let msgIdx = 0; msgIdx < messages.length; msgIdx++) {
    const msg = messages[msgIdx];
    if (!isDedupEligibleMessage(msg)) {
      continue;
    }

    const role = messageRole(msg);
    const contents = Array.isArray(msg.content) ? msg.content : [msg.content];
    for (let blockIdx = 0; blockIdx < contents.length; blockIdx++) {
      const block = contents[blockIdx] as TextLikeBlock;
      const text = getBlockText(block);
      if (typeof text !== "string" || !text.trim()) {
        continue;
      }

      const canonicalText = normalizeTextForDedup(text, role);
      if (!canonicalText.trim()) {
        continue;
      }

      countsByCanonicalText.set(canonicalText, (countsByCanonicalText.get(canonicalText) || 0) + 1);

      if (!firstByCanonicalText.has(canonicalText)) {
        firstByCanonicalText.set(canonicalText, {
          text,
          canonicalText,
          messageIndex: msgIdx,
          blockIndex: blockIdx,
          toolCallId: typeof msg?.toolCallId === "string" ? msg.toolCallId : undefined,
        });
      }
    }
  }

  const dedupCanonicalTexts = new Set<string>();
  const omittedRepeatsByCanonicalText = new Map<string, number>();
  for (const [canonicalText, count] of countsByCanonicalText) {
    if (count <= 1) {
      continue;
    }
    const first = firstByCanonicalText.get(canonicalText);
    if (!first) {
      continue;
    }
    if (canonicalText.length < config.minContentSize) {
      continue;
    }
    dedupCanonicalTexts.add(canonicalText);
    omittedRepeatsByCanonicalText.set(canonicalText, Math.max(1, count - 1));
  }

  function makePlainPointer(first: FirstOccurrence, omittedRepeats: number): string {
    const toolHint = first.toolCallId ? ` (toolCallId ${first.toolCallId})` : "";
    const repeatLabel = omittedRepeats === 1 ? "repeat" : "repeats";
    return (
      `[${omittedRepeats} ${repeatLabel} of content omitted]\n` +
      `Same as context message #${first.messageIndex}, block #${first.blockIndex}${toolHint}.`
    );
  }

  const seenOrderByCanonicalText = new Map<string, number>();
  const newMessages: any[] = messages.map((msg, msgIdx) => {
    if (!isDedupEligibleMessage(msg)) {
      return msg;
    }

    const isProtectedMessage = protectedMessageIndexes.has(msgIdx);
    const role = messageRole(msg);
    const isArrayContent = Array.isArray(msg.content);
    const contents = isArrayContent ? msg.content : [msg.content];

    const newContents = contents.map((block: TextLikeBlock) => {
      const text = getBlockText(block);
      if (typeof text !== "string" || !text.trim()) {
        return block;
      }

      const canonicalText = normalizeTextForDedup(text, role);
      if (!canonicalText.trim()) {
        return block;
      }

      if (!dedupCanonicalTexts.has(canonicalText)) {
        return block;
      }

      const seenCount = seenOrderByCanonicalText.get(canonicalText) || 0;
      seenOrderByCanonicalText.set(canonicalText, seenCount + 1);

      // Keep the first occurrence as full content; only replace repeats.
      if (seenCount === 0) {
        return block;
      }

      // Protect lineage source messages from becoming pointers, which would create nested refs.
      if (isProtectedMessage) {
        return block;
      }

      const first = firstByCanonicalText.get(canonicalText);
      if (!first) {
        return block;
      }

      const omittedRepeats = omittedRepeatsByCanonicalText.get(canonicalText) || 1;
      const pointer = makePlainPointer(first, omittedRepeats);
      if (pointer.length >= text.length) {
        return block;
      }

      return replaceBlockText(block, pointer);
    });

    return {
      ...msg,
      content: isArrayContent ? newContents : newContents[0],
    };
  });

  return {
    messages: newMessages,
  };
}
