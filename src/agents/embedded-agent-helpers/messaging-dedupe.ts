/**
 * Normalizes outbound message text to suppress duplicate send actions.
 */
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";

const MIN_DUPLICATE_TEXT_LENGTH = 10;
const MIN_REVERSE_SUBSTRING_DUPLICATE_RATIO = 0.5;
// Maximum length for a "post-tool-send meta commentary" candidate. Real
// replies are longer than this; meta-acks ("已发 #22141", "Sent above")
// are short trailing acknowledgements after a message-tool send.
const MAX_META_COMMENTARY_LENGTH = 200;
// Sentence-boundary delimiters for compound ack splitting.
const SENTENCE_BOUNDARY_RE = /[.;,。，；！？!\n]\s*/g;

/**
 * Patterns that match a post-tool-send meta-acknowledgement phrase.
 *
 * Each pattern is anchored (`^...$`) and matches the ack phrase followed
 * **only** by trailing punctuation, whitespace, parenthesised message refs
 * (`(#22142)`), or numeric refs (`#22141`). The ack phrase itself must
 * stand alone as the dominant content — prefix-only matches are rejected
 * so that real replies like `Oklahoma weather`, `sentence fixed`,
 * `已发现问题`, `okay let's go` are NOT suppressed.
 *
 * Compound meta-acks (`Sent. Replied in thread.`, `已发, 不再追加总结`,
 * `OK. Done.`) are detected by splitting on sentence boundaries and
 * checking that every segment independently matches a pattern from this
 * list. See `isCompoundMetaCommentary`.
 */
const META_COMMENTARY_PATTERNS: readonly RegExp[] = [
  // Chinese standalone acks: "已发", "已发送", "主回复已发", "好了", "收到"
  /^(?:已发(?:送|完毕|完成)?|主回复已发|消息已发(?:出|送)?|回复已发|好了?|收到|完毕|完成|了解|知道了|明白)[\s.,。!；;?？、()#\d]*$/u,
  // Chinese mid-text acks: "核心回答如下", "总结如下", "不再追加"
  /^(?:核心回答如下|总结如下|以下为核心(?:回答|内容)?|以下为总结|不再追加(?:总结|内容)?|以下为回复|答案如下|如上|回复如上)[\s.,。!；;?？、()#\d]*$/u,
  // English standalone acks: "OK", "Sent", "Done", "Roger", "Got it", ...
  /^(?:sent(?:\s+(?:above|#\d+|\([^)]+\)))?|done\.?|replied(?:\s+(?:above|in\s+thread))?|see\s+above|as\s+above|posted\.?|acknowledged\.?|ok(?:ay)?|got\s+it|gotcha|roger|cop(?:y|ied)(?:\s+that)?|ack(?:nowledged)?|will\s+do|on\s+it|noted|understood|thanks|thx)[\s.,!；;?？()#\d]*$/i,
  // English mid-text: "Replying above", "Answer below", "Response above"
  /^(?:replying\s+(?:above|below|in\s+thread)|answer\s+below|response\s+above|sent\s+in\s+thread)[\s.,!；;?？()#\d]*$/i,
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

/**
 * Detect compound meta-acks where every sentence-boundary-delimited
 * segment is itself a short meta-acknowledgement.
 *
 * Used as a second pass after the full-text anchored pattern match
 * so that multi-sentence acks like `Sent. Replied in thread.` and
 * `已发, 不再追加总结` are caught, while mixed-form texts like
 * `OK, that's the fix.` or `已发. Now let me explain...` are
 * preserved because at least one segment does not match any ack
 * pattern.
 */
function isCompoundMetaCommentary(normalized: string): boolean {
  const segments = normalized.split(SENTENCE_BOUNDARY_RE).filter((s) => s.trim().length > 0);
  if (segments.length < 2) return false;
  // Every segment must independently match a meta-ack pattern.
  // A single non-matching segment means the text has real content.
  return segments.every((segment) =>
    META_COMMENTARY_PATTERNS.some((pattern) => pattern.test(segment.trim())),
  );
}

/**
 * Detect short post-tool-send meta commentary.
 *
 * After an agent runs a message-tool send in the same turn, models
 * sometimes append a trailing acknowledgement like "已发 #22141",
 * "Sent above", "核心回答如下", "OK", "Roger" or "Got it". These
 * acks add no information beyond the message-tool send itself and
 * reach the channel as a second visible message — a well-known
 * duplicate-reply pattern.
 *
 * Detection is intentionally conservative:
 *  - Normalized text must be ≤ MAX_META_COMMENTARY_LENGTH chars
 *  - Full-text anchored pattern match is attempted first (standalone
 *    acks like `已发`, `OK`, `Sent above`)
 *  - If that fails, compound ack detection splits on sentence
 *    boundaries and verifies every segment is itself ack-like
 *  - Used only when a message-tool send has already happened this
 *    turn (caller responsibility — see
 *    `filterMessagingToolMetaCommentary`)
 */
export function isPostToolSendMetaCommentary(text: string): boolean {
  const normalized = normalizeTextForComparison(text);
  if (!normalized || normalized.length > MAX_META_COMMENTARY_LENGTH) {
    return false;
  }
  // Full-text anchored match first (standalone acks).
  if (META_COMMENTARY_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return true;
  }
  // Second pass: compound ack detection.
  return isCompoundMetaCommentary(normalized);
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
