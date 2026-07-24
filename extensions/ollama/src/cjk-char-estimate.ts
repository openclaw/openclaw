/**
 * CJK-aware character weighting for Ollama usage fallback estimates.
 *
 * Mirrored from `src/utils/cjk-chars.ts` (extensions cannot import core
 * internals). Keep the regex and weighting formula in sync with that helper.
 */

const CHARS_PER_TOKEN_ESTIMATE = 4;

const NON_LATIN_RE =
  /[\u2E80-\u9FFF\uA000-\uA4FF\uAC00-\uD7AF\uF900-\uFAFF\uFF01-\uFF60\uFFE0-\uFFE6\u{20000}-\u{2FA1F}]/gu;

const CJK_SURROGATE_HIGH_RE = /[\uD840-\uD87E][\uDC00-\uDFFF]/g;

function countCodePoints(text: string, nonLatinCount: number): number {
  if (nonLatinCount === 0) {
    return text.length;
  }
  const cjkSurrogates = (text.match(CJK_SURROGATE_HIGH_RE) ?? []).length;
  return text.length - cjkSurrogates;
}

/** Inflate non-Latin length so `chars / 4` stays accurate for CJK scripts. */
export function estimateStringChars(text: string): number {
  if (text.length === 0) {
    return 0;
  }
  const nonLatinCount = (text.match(NON_LATIN_RE) ?? []).length;
  const codePointLength = countCodePoints(text, nonLatinCount);
  return codePointLength + nonLatinCount * (CHARS_PER_TOKEN_ESTIMATE - 1);
}

export { CHARS_PER_TOKEN_ESTIMATE };
