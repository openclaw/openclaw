import { avoidTrailingHighSurrogateBreak } from "./utf16-slice.js";

let graphemeSegmenter: Intl.Segmenter | undefined;

// Lazy initialization keeps unused browser imports free of Segmenter side effects.
function getGraphemeSegmenter(): Intl.Segmenter {
  graphemeSegmenter ??= new Intl.Segmenter(undefined, { granularity: "grapheme" });
  return graphemeSegmenter;
}

/**
 * Chooses a whole-grapheme cut within the hard budget, honoring a usable preference.
 * If no whole grapheme fits, allowPartial permits a surrogate-safe progress cut;
 * a leading surrogate pair can exceed maxEnd by one code unit.
 */
export function findGraphemeChunkEnd(
  text: string,
  start: number,
  maxEnd: number,
  preferredEnd = maxEnd,
  allowPartial = true,
): number {
  const hardEnd = Math.min(maxEnd, text.length);
  if (hardEnd <= start) {
    return start;
  }
  const preferred =
    Number.isInteger(preferredEnd) && preferredEnd > start && preferredEnd <= hardEnd
      ? preferredEnd
      : hardEnd;
  if (preferred === text.length) {
    return preferred;
  }

  const segments = getGraphemeSegmenter().segment(text);
  let end = segments.containing(preferred)?.index ?? preferred;
  if (end <= start && preferred < hardEnd) {
    end = hardEnd === text.length ? hardEnd : (segments.containing(hardEnd)?.index ?? hardEnd);
  }
  return end > start
    ? end
    : allowPartial
      ? avoidTrailingHighSurrogateBreak(text, start, hardEnd)
      : start;
}

/** Width to reserve for the first whole grapheme, or zero for empty text. */
export function firstGraphemeClusterLength(text: string): number {
  if (!text) {
    return 0;
  }
  return getGraphemeSegmenter().segment(text).containing(0)?.segment.length ?? 0;
}

const WHITESPACE_GRAPHEME_RE = /^\s+$/u;

/** Skips only whole whitespace graphemes, never the base of a space-plus-mark cluster. */
export function skipWhitespaceGraphemes(
  text: string,
  start = 0,
  maxGraphemes = Number.POSITIVE_INFINITY,
): number {
  if (!/\s/u.test(text.charAt(start))) {
    return start;
  }
  const segments = getGraphemeSegmenter().segment(text);
  let cursor = start;
  for (let count = 0; count < maxGraphemes && cursor < text.length; count += 1) {
    const cluster = segments.containing(cursor);
    if (!cluster || cluster.index !== cursor || !WHITESPACE_GRAPHEME_RE.test(cluster.segment)) {
      break;
    }
    cursor += cluster.segment.length;
  }
  return cursor;
}

/** Trims only whole trailing whitespace graphemes from a source prefix. */
export function trimEndWhitespaceGraphemes(text: string, end = text.length): string {
  if (!/\s/u.test(text.charAt(end - 1))) {
    return text.slice(0, end);
  }
  const segments = getGraphemeSegmenter().segment(text);
  let cursor = end;
  while (cursor > 0) {
    const cluster = segments.containing(cursor - 1);
    if (
      !cluster ||
      cluster.index + cluster.segment.length > cursor ||
      !WHITESPACE_GRAPHEME_RE.test(cluster.segment)
    ) {
      break;
    }
    cursor = cluster.index;
  }
  return text.slice(0, cursor);
}
