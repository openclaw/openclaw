const ZERO_WIDTH_RE = /(?:­|ᅟ|ᅠ|​|‌|‍|‎|‏|[‪-‮]|⁠|[⁦-⁩]|﻿)/g;

/**
 * Normalize text before keyword matching.
 *
 * Steps (applied in order):
 *   1. Unicode NFC  — unify composed/decomposed forms (é NFD → é NFC)
 *   2. Fullwidth → halfwidth  — U+FF01..U+FF5E → U+0021..U+007E (ａ→a, １→1, ！→!)
 *   3. Strip zero-width and invisible formatting chars — common zero-width, bidi, and Hangul filler bypass chars
 *   4. Lowercase              — when caseSensitive=false (default)
 */
export function normalizeText(text: string, caseSensitive = false): string {
  let result = text.normalize("NFC");

  // Fullwidth ASCII → halfwidth
  let buf = "";
  for (let i = 0; i < result.length; i++) {
    const code = result.charCodeAt(i);
    buf += code >= 0xff01 && code <= 0xff5e ? String.fromCharCode(code - 0xfee0) : result[i];
  }
  result = buf;

  result = result.replace(ZERO_WIDTH_RE, "");

  if (!caseSensitive) {
    result = result.toLowerCase();
  }
  return result;
}
