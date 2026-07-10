/**
 * CJK-aware character counting for accurate token estimation.
 *
 * Most LLM tokenizers encode CJK characters as roughly one token per character,
 * whereas Latin text averages one token per four characters.
 */

/** Default characters-per-token ratio used throughout the codebase. */
export const CHARS_PER_TOKEN_ESTIMATE = 4;

const NON_LATIN_RE =
  /[\u2E80-\u9FFF\uA000-\uA4FF\uAC00-\uD7AF\uF900-\uFAFF\uFF01-\uFF60\uFFE0-\uFFE6\u{20000}-\u{2FA1F}]/gu;

/**
 * Return a character length adjusted so that the standard chars-per-token
 * heuristic accounts for CJK text while leaving Latin text unchanged.
 */
export function estimateStringChars(text: string): number {
  if (text.length === 0) {
    return 0;
  }
  const nonLatinCount = (text.match(NON_LATIN_RE) ?? []).length;
  const codePointLength = countCjkCodePoints(text, nonLatinCount);
  return codePointLength + nonLatinCount * (CHARS_PER_TOKEN_ESTIMATE - 1);
}

const CJK_SURROGATE_HIGH_RE = /[\uD840-\uD87E][\uDC00-\uDFFF]/g;

function countCjkCodePoints(text: string, nonLatinCount: number): number {
  if (nonLatinCount === 0) {
    return text.length;
  }
  // CJK Extension B+ code points use two UTF-16 code units but one token-sized character.
  return text.length - (text.match(CJK_SURROGATE_HIGH_RE) ?? []).length;
}

/** Estimate tokens from an adjusted character count. */
export function estimateTokensFromChars(chars: number): number {
  return Math.ceil(Math.max(0, chars) / CHARS_PER_TOKEN_ESTIMATE);
}
