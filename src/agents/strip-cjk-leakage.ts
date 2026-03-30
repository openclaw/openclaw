/**
 * Strip leaked CJK characters from non-CJK model output.
 *
 * MiniMax M2 models (including M2.7) are trained heavily on Chinese data and
 * occasionally leak CJK (Chinese/Japanese/Korean) characters into outputs
 * that should be in Latin-script or other non-CJK languages (German, English,
 * Korean Hangul, etc.). This is a known model-level bug documented in:
 * - GitHub MiniMax-M2 Issue #100 (Korean → Chinese leakage)
 * - OpenClaw Issue #17121 (Japanese → Chinese/Russian leakage)
 * - MiniMax-M2 Issue #55 (punctuation confusion)
 *
 * This post-processing filter detects when the majority of text is non-CJK
 * and strips stray CJK ideograph characters that were injected by the model.
 *
 * **Safety:** If >20% of the text is CJK, the text is returned untouched —
 * the user is likely writing in a CJK language. CJK punctuation is only
 * replaced when the text is predominantly non-CJK.
 *
 * @see https://github.com/openclaw/openclaw/issues/17121
 */

// CJK Unified Ideographs (Chinese characters / Kanji / Hanja)
const CJK_IDEOGRAPH_RE = /[\u4E00-\u9FFF\u3400-\u4DBF]/g;

// CJK punctuation that may be injected in place of Latin/standard punctuation.
// Full-width period, comma, colon, semicolon, question mark, exclamation,
// ideographic comma, ideographic period, left/right CJK quotes.
const CJK_PUNCTUATION_RE = /[\uFF01\uFF0C\uFF1A\uFF1B\uFF1F\u3001\u3002\u300C\u300D\u300E\u300F]/g;

// Threshold: if CJK ideographs make up more than this fraction of all
// word-like characters, we assume the output is intentionally CJK.
const CJK_FRACTION_THRESHOLD = 0.2;

/**
 * Count the number of characters in the text that match a given regex.
 */
function countMatches(text: string, re: RegExp): number {
  re.lastIndex = 0;
  let count = 0;
  while (re.exec(text)) {
    count += 1;
  }
  re.lastIndex = 0;
  return count;
}

// CJK punctuation → Latin equivalent mapping.
const CJK_PUNCT_MAP: Record<string, string> = {
  "\uFF01": "!", // ！→ !
  "\uFF0C": ",", // ，→ ,
  "\uFF1A": ":", // ：→ :
  "\uFF1B": ";", // ；→ ;
  "\uFF1F": "?", // ？→ ?
  "\u3001": ",", // 、→ ,
  "\u3002": ".", // 。→ .
  "\u300C": '"', // 「→ "
  "\u300D": '"', // 」→ "
  "\u300E": '"', // 『→ "
  "\u300F": '"', // 』→ "
};

/**
 * Strip leaked CJK ideographs and punctuation from predominantly non-CJK text.
 *
 * Returns the original text unchanged if:
 * - The text is empty/falsy
 * - The text contains no CJK ideographs
 * - More than 20% of word characters are CJK (intentional CJK content)
 */
export function stripLeakedCjkChars(text: string): string {
  if (!text) {
    return text;
  }

  const cjkIdeographCount = countMatches(text, CJK_IDEOGRAPH_RE);
  const cjkPunctCount = countMatches(text, CJK_PUNCTUATION_RE);

  if (cjkIdeographCount === 0 && cjkPunctCount === 0) {
    return text;
  }

  // Count "word-like" characters: letters (any script) and CJK ideographs.
  // We use a simple heuristic: everything that isn't whitespace or common
  // punctuation is a "word character" for ratio purposes.
  const wordChars = text.replace(/[\s\p{P}\p{S}]/gu, "");
  const totalWordChars = wordChars.length;

  if (totalWordChars === 0) {
    // Text is only whitespace/punctuation/symbols — no word chars to judge.
    // If there are CJK ideographs in a non-word context, strip them.
    // (This is an edge case — e.g. "   下   " → "      ")
    let cleaned = text.replace(CJK_IDEOGRAPH_RE, "");
    cleaned = cleaned.replace(CJK_PUNCTUATION_RE, (ch) => CJK_PUNCT_MAP[ch] ?? ch);
    return cleaned;
  }

  const cjkFraction = cjkIdeographCount / totalWordChars;
  if (cjkFraction > CJK_FRACTION_THRESHOLD) {
    // Likely intentional CJK content — leave it alone.
    return text;
  }

  // Strip CJK ideographs. They appear as stray characters amid Latin text.
  // If surrounded by spaces, collapse to single space. If adjacent to other
  // text, just remove the character.
  let cleaned = text.replace(CJK_IDEOGRAPH_RE, "");

  // Replace CJK punctuation with Latin equivalents.
  cleaned = cleaned.replace(CJK_PUNCTUATION_RE, (ch) => CJK_PUNCT_MAP[ch] ?? ch);

  // Clean up leftover artifacts: collapse multiple spaces.
  cleaned = cleaned.replace(/  +/g, " ");

  return cleaned;
}
