const MIN_DUPLICATE_TEXT_LENGTH = 10;

/**
 * Normalize text for duplicate comparison.
 * - Trims whitespace
 * - Lowercases
 * - Strips emoji (Emoji_Presentation and Extended_Pictographic)
 * - Collapses multiple spaces to single space
 */
// Pre-compiled Unicode emoji pattern — avoids recompilation per call.
const EMOJI_PATTERN = /\p{Emoji_Presentation}|\p{Extended_Pictographic}/gu;

export function normalizeTextForComparison(text: string): string {
  const trimmed = text.trim().toLowerCase();
  // Fast path: skip the expensive Unicode emoji regex for ASCII-only text,
  // which is the common case for code output and most agent responses.
  // eslint-disable-next-line no-control-regex
  if (/[^\x00-\x7F]/.test(trimmed)) {
    return trimmed.replace(EMOJI_PATTERN, "").replace(/\s+/g, " ").trim();
  }
  return trimmed.replace(/\s+/g, " ").trim();
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
    return normalized.includes(normalizedSent) || normalizedSent.includes(normalized);
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
