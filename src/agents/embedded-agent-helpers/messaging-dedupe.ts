/**
 * Normalizes outbound message text to suppress duplicate send actions.
 */
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";

const MIN_DUPLICATE_TEXT_LENGTH = 10;
const MIN_REVERSE_SUBSTRING_DUPLICATE_RATIO = 0.5;
const MAX_POST_TOOL_SEND_META_ACK_LENGTH = 80;
const POST_TOOL_SEND_META_ACK_PATTERNS: readonly RegExp[] = [
  /^(?:已发(?:送|出|完毕)?|回复已发(?:送|出)?|主回复已发|消息已发(?:送|出)?)(?:[\s,，。.!！:：-]*(?:[#＃][\p{L}\p{N}_-]+|\d+))?[\s。.!！]*$/iu,
  /^(?:核心回答如下|总结如下|答案如下|不再追加(?:内容|回复)?)[\s。.!！:：]*$/u,
  /^(?:sent(?:\s+(?:above|already|[#＃][\p{L}\p{N}_-]+))?|posted|done|ok(?:ay)?|roger|got\s+it|ack(?:nowledged)?|replied\s+above)[\s。.!！]*$/iu,
];

/**
 * Normalize text for duplicate comparison.
 * - Trims whitespace
 * - Lowercases
 * - Strips emoji (Emoji_Presentation and Extended_Pictographic)
 * - Collapses multiple spaces to single space
 */
export function normalizeTextForComparison(text: string): string {
  return normalizeLowercaseStringOrEmpty(text)
    .replace(/\p{Emoji_Presentation}|\p{Extended_Pictographic}/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function isPostToolSendMetaAck(text: string): boolean {
  const normalized = normalizeTextForComparison(text);
  if (!normalized || normalized.length > MAX_POST_TOOL_SEND_META_ACK_LENGTH) {
    return false;
  }
  return POST_TOOL_SEND_META_ACK_PATTERNS.some((pattern) => pattern.test(normalized));
}

/** Compare already-normalized message text against prior sends. */
export function isMessagingToolDuplicateNormalized(
  normalized: string,
  normalizedSentTexts: string[],
): boolean {
  if (normalizedSentTexts.length === 0) {
    return false;
  }
  if (!normalized || normalized.length < MIN_DUPLICATE_TEXT_LENGTH) {
    return false;
  }
  return normalizedSentTexts.some((normalizedSent) => {
    if (!normalizedSent || normalizedSent.length < MIN_DUPLICATE_TEXT_LENGTH) {
      return false;
    }
    if (normalized.includes(normalizedSent)) {
      return true;
    }
    return (
      normalizedSent.includes(normalized) &&
      normalized.length >= normalizedSent.length * MIN_REVERSE_SUBSTRING_DUPLICATE_RATIO
    );
  });
}

/** Return true when raw message text duplicates a prior sent message. */
export function isMessagingToolDuplicate(text: string, sentTexts: string[]): boolean {
  if (sentTexts.length === 0) {
    return false;
  }
  const normalized = normalizeTextForComparison(text);
  if (!normalized || normalized.length < MIN_DUPLICATE_TEXT_LENGTH) {
    return false;
  }
  return isMessagingToolDuplicateNormalized(normalized, sentTexts.map(normalizeTextForComparison));
}
