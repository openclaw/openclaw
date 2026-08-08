// Telegram renders <pre> table fallbacks in a monospace font where East Asian
// Wide/Fullwidth code points and emoji occupy two cells. String.length counts
// UTF-16 code units, which undercounts CJK (one unit, two cells) and
// miscounts emoji (two units, two cells), so padding by .length misaligns
// every column once a cell contains non-ASCII text.
// Width is measured per grapheme cluster so combining marks and ZWJ joiners
// add no cells of their own: a decomposed accent keeps its base character's
// width, and an emoji-ZWJ sequence renders as a single two-cell glyph.
// Wide ranges mirror the CJK set in packages/ai/src/transports/transport-utils.ts.
const WIDE_CODE_POINT_PATTERN =
  /[\u1100-\u115F\u2E80-\u9FFF\uA000-\uA4FF\uAC00-\uD7AF\uF900-\uFAFF\uFE30-\uFE4F\uFF01-\uFF60\uFFE0-\uFFE6\u{1F1E6}-\u{1F1FF}\u{1F300}-\u{1FAFF}\u{20000}-\u{2FA1F}]/u;

// U+FE0F forces emoji presentation (and therefore a two-cell glyph) on bases
// that are otherwise narrow, e.g. U+2764 U+FE0F.
const EMOJI_PRESENTATION_SELECTOR = "\uFE0F";

// U+20E3 turns a digit/#/* base into a keycap emoji (two cells) even without
// VS16, so it widens the cluster on its own.
const KEYCAP_COMBINING_MARK = "\u20E3";

// Digits, # and * are emoji-capable only as keycap bases: with a bare VS16 and
// no U+20E3 they keep text presentation (one cell), so VS16 must not widen them.
const KEYCAP_BASE_PATTERN = /^[0-9#*]$/u;
const EMOJI_CAPABLE_BASE_PATTERN = /\p{Emoji}/u;

const graphemeSegmenter =
  typeof Intl.Segmenter === "function"
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
    : undefined;

function codePointWidth(codePoint: string): number {
  return WIDE_CODE_POINT_PATTERN.test(codePoint) ? 2 : 1;
}

function graphemeClusterWidth(cluster: string): number {
  let hasEmojiSelector = false;
  let hasKeycapMark = false;
  let hasEmojiCapableBase = false;
  for (const codePoint of cluster) {
    if (codePointWidth(codePoint) === 2) {
      return 2;
    }
    if (codePoint === EMOJI_PRESENTATION_SELECTOR) {
      hasEmojiSelector = true;
    } else if (codePoint === KEYCAP_COMBINING_MARK) {
      hasKeycapMark = true;
    } else if (!KEYCAP_BASE_PATTERN.test(codePoint) && EMOJI_CAPABLE_BASE_PATTERN.test(codePoint)) {
      hasEmojiCapableBase = true;
    }
  }
  return hasKeycapMark || (hasEmojiSelector && hasEmojiCapableBase) ? 2 : 1;
}

export function telegramMonospaceWidth(text: string): number {
  if (!graphemeSegmenter) {
    let fallbackWidth = 0;
    for (const codePoint of text) {
      fallbackWidth += codePointWidth(codePoint);
    }
    return fallbackWidth;
  }
  let width = 0;
  for (const { segment } of graphemeSegmenter.segment(text)) {
    width += graphemeClusterWidth(segment);
  }
  return width;
}

export function padEndTelegramMonospace(text: string, targetWidth: number): string {
  const missing = targetWidth - telegramMonospaceWidth(text);
  return missing > 0 ? text + " ".repeat(missing) : text;
}
