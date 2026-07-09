// Telegram tests cover progress text clipping behavior.
export const TELEGRAM_PROGRESS_MAX_CHARS = 300;

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * Clips Telegram progress text to at most {@link TELEGRAM_PROGRESS_MAX_CHARS}
 * grapheme clusters, slicing at a grapheme cluster boundary so that ZWJ emoji
 * sequences (like 👨‍👩‍👧‍👦) and other multi-codepoint clusters are never broken.
 */
export function clipTelegramProgressText(text: string): string {
  const segments = Array.from(graphemeSegmenter.segment(text));
  if (segments.length <= TELEGRAM_PROGRESS_MAX_CHARS) {
    return text;
  }
  const truncated = segments
    .slice(0, TELEGRAM_PROGRESS_MAX_CHARS - 1)
    .map((s) => s.segment)
    .join("");
  return `${truncated.trimEnd()}…`;
}
