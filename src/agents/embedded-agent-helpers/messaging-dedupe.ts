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

/**
 * Patterns that mark a short trailing text as post-tool-send meta commentary
 * (an agent acknowledging that it just sent its main reply via a tool, not a
 * real follow-up message).
 *
 * Each pattern matches the ack phrase followed **only** by trailing
 * punctuation, whitespace, parenthesised message refs (`(#22142)`), or
 * numeric refs (`#22141`). The ack phrase itself must stand alone as the
 * dominant content of the text — prefix-only matches are deliberately
 * rejected so that real replies like `Oklahoma weather`, `sentence fixed`,
 * `已发现问题`, `okay let's go` are NOT suppressed.
 *
 * Compound meta-acks (`OK, that's the fix.`, `Roger, copy.`) are NOT
 * auto-suppressed by this filter — the agent can still send them, but the
 * filter errs on the side of preserving legitimate short replies. The
 * filter only catches the dominant case: short standalone acks that add no
 * information beyond the message-tool send already in the channel.
 */
const META_COMMENTARY_PATTERNS: readonly RegExp[] = [
  // Chinese standalone acks: "已发", "已发送", "主回复已发", "好了", "收到"
  /^(?:已发(?:送|完毕)?|主回复已发|消息已发(?:出|送)?|回复已发|好了?|收到|完毕|完成)[\s.,。!；;?？、()#\d]*$/u,
  // Chinese mid-text acks: "核心回答如下", "总结如下", "不再追加"
  /^(?:核心回答如下|总结如下|以下为核心|以下为总结|不再追加(?:总结|内容)?|以下为回复|答案如下)[\s.,。!；;?？、()#\d]*$/u,
  // English standalone acks: "OK", "Sent", "Done", "Roger", "Got it", ...
  /^(?:sent(?:\s+(?:above|#\d+|\([^)]+\)))?|done\.?|replied(?:\s+above)?|posted\.?|acknowledged\.?|ok(?:ay)?|got\s+it|roger|copy(?:\s+that)?|ack(?:nowledged)?)[\s.,!；;?？()#\d]*$/i,
  // English mid-text: "Replying above", "Answer below", "Response above"
  /^(?:replying\s+(?:above|below|in\s+thread)|answer\s+below|response\s+above)[\s.,!；;?？()#\d]*$/i,
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
 * Detect short post-tool-send meta commentary.
 *
 * After an agent runs a message-tool send in the same turn, models sometimes
 * append a trailing acknowledgement like "已发 #22141", "Sent above",
 * "核心回答如下", "OK", "Roger" or "Got it". These acks add no information
 * beyond the message-tool send itself, and reach the channel as a second
 * visible message — a well-known duplicate-reply pattern.
 *
 * Detection is intentionally conservative:
 *  - Normalized text must be ≤ MAX_META_COMMENTARY_LENGTH chars
 *  - The entire normalized text must match one of the ack patterns in
 *    `META_COMMENTARY_PATTERNS` — prefix-only matches are rejected so that
 *    real replies like `Oklahoma weather`, `sentence fixed`, `已发现问题`
 *    are NOT suppressed
 *  - Used only when a message-tool send has already happened this turn
 *    (caller responsibility — see `filterMessagingToolMetaCommentary`)
 */
export function isPostToolSendMetaCommentary(text: string): boolean {
  const normalized = normalizeTextForComparison(text);
  if (!normalized || normalized.length > MAX_META_COMMENTARY_LENGTH) {
    return false;
  }
  return META_COMMENTARY_PATTERNS.some((pattern) => pattern.test(normalized));
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
