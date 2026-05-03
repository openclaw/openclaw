import { normalizeLowercaseStringOrEmpty } from "../../shared/string-coerce.js";

const MIN_DUPLICATE_TEXT_LENGTH = 10;

// Minimum length ratio for the "sent text contains candidate" direction of dedup.
// A candidate shorter than this fraction of the sent text is not suppressed as a
// substring match — it is short commentary that incidentally appears within a long
// message-tool payload and should still be delivered.
const MIN_SUBSTRING_SUPPRESSION_RATIO = 0.5;

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
    // The candidate contains the sent text — the assistant is re-narrating it.
    if (normalized.includes(normalizedSent)) {
      return true;
    }
    // The sent text contains the candidate — but only suppress when the candidate
    // is substantial relative to the sent text. Short commentary (e.g. "delivered
    // your file!") must not be suppressed because it accidentally appears as a
    // substring inside a long message-tool payload (#76915).
    if (
      normalizedSent.includes(normalized) &&
      normalized.length >= normalizedSent.length * MIN_SUBSTRING_SUPPRESSION_RATIO
    ) {
      return true;
    }
    return false;
  });
}

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
