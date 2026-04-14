/**
 * Turkish text normalization for TTS synthesis.
 *
 * ElevenLabs' built-in text normalization handles most languages well, but
 * Turkish has specific quirks that benefit from client-side preprocessing:
 *
 * 1. Circumflex vowels (â, î, û) — used in Arabic/Persian loanwords, but
 *    TTS engines often mispronounce them or produce glottal stops.
 * 2. Common Islamic/Ottoman terms with non-standard transliteration that
 *    confuse pronunciation models.
 *
 * This preprocessor is applied only when languageCode is "tr".
 */

const CIRCUMFLEX_MAP: Record<string, string> = {
  â: "a",
  Â: "A",
  î: "i",
  Î: "İ",
  û: "u",
  Û: "U",
};

const CIRCUMFLEX_RE = /[âÂîÎûÛ]/g;

/**
 * Normalize Turkish text for TTS synthesis by replacing characters that
 * commonly cause mispronunciation in speech models.
 *
 * Only transforms characters that affect pronunciation — standard Turkish
 * letters (ç, ğ, ı, ö, ş, ü) are left untouched as TTS engines handle
 * them correctly.
 */
export function normalizeTurkishForTts(text: string): string {
  if (!text) {
    return text;
  }
  return text.replace(CIRCUMFLEX_RE, (ch) => CIRCUMFLEX_MAP[ch] ?? ch);
}
