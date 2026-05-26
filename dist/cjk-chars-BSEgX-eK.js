/**
* Matches CJK Unified Ideographs, CJK Extension A/B, CJK Compatibility
* Ideographs, Hangul Syllables, Hiragana, Katakana, and other non-Latin
* scripts that typically use ~1 token per character.
*/
const NON_LATIN_RE = /[\u2E80-\u9FFF\uA000-\uA4FF\uAC00-\uD7AF\uF900-\uFAFF\u{20000}-\u{2FA1F}]/gu;
/**
* Return an adjusted character length that accounts for non-Latin (CJK, etc.)
* characters.  Each non-Latin character is counted as
* {@link CHARS_PER_TOKEN_ESTIMATE} chars so that the downstream
* `chars / CHARS_PER_TOKEN_ESTIMATE` token estimate remains accurate.
*
* For pure ASCII/Latin text the return value equals `text.length` (no change).
*/
function estimateStringChars(text) {
	if (text.length === 0) return 0;
	const nonLatinCount = (text.match(NON_LATIN_RE) ?? []).length;
	return countCodePoints(text, nonLatinCount) + nonLatinCount * 3;
}
/**
* Matches surrogate pairs whose code point falls in the CJK Extension B+
* range (U+20000–U+2FA1F).  Only these surrogates need adjustment because
* they are matched by {@link NON_LATIN_RE} and already counted in
* `nonLatinCount`.  Other surrogates (emoji, symbols) are not matched by
* that regex, so collapsing them would create an inconsistency.
*
* High-surrogate range for U+20000–U+2FA1F is D840–D87E.
*/
const CJK_SURROGATE_HIGH_RE = /[\uD840-\uD87E][\uDC00-\uDFFF]/g;
/**
* Return the code-point-aware length of the string, adjusting only for
* CJK Extension B+ surrogate pairs.  For text without such characters
* (the vast majority of inputs) this returns `text.length` unchanged.
*/
function countCodePoints(text, nonLatinCount) {
	if (nonLatinCount === 0) return text.length;
	const cjkSurrogates = (text.match(CJK_SURROGATE_HIGH_RE) ?? []).length;
	return text.length - cjkSurrogates;
}
/**
* Estimate the number of tokens from a raw character count.
*
* For a more accurate estimate when the source text is available, prefer
* `estimateStringChars(text) / CHARS_PER_TOKEN_ESTIMATE` instead.
*/
function estimateTokensFromChars(chars) {
	return Math.ceil(Math.max(0, chars) / 4);
}
//#endregion
export { estimateTokensFromChars as n, estimateStringChars as t };
