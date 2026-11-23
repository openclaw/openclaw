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

  // Adjacent ASCII code units always break except CRLF. Avoid copying the entire
  // source into ICU for each chunk of a long reply; non-ASCII boundaries need ICU.
  const before = text.charCodeAt(preferred - 1);
  const after = text.charCodeAt(preferred);
  if (
    Number.isInteger(preferred) &&
    before <= 0x7f &&
    after <= 0x7f &&
    !(before === 0x0d && after === 0x0a)
  ) {
    return preferred;
  }

  // A boundary depends only on the text before it and the next code point, so a
  // window ending two code units past the budget gives the same answer as the whole text.
  const segments = getGraphemeSegmenter().segment(text.slice(start, hardEnd + 2));
  const boundaryAt = (position: number) =>
    (segments.containing(position - start)?.index ?? position - start) + start;
  let end = boundaryAt(preferred);
  if (end <= start && preferred < hardEnd) {
    end = hardEnd === text.length ? hardEnd : boundaryAt(hardEnd);
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
const INITIAL_WINDOW = 256;

/** Skips only whole whitespace graphemes, never the base of a space-plus-mark cluster. */
export function skipWhitespaceGraphemes(
  text: string,
  start = 0,
  maxGraphemes = Number.POSITIVE_INFINITY,
): number {
  if (!/\s/u.test(text.charAt(start))) {
    return start;
  }
  // Two units of left context reveal a CRLF or prepend cluster that already owns this whitespace.
  const lead = Math.min(start, 2);
  const owner = getGraphemeSegmenter()
    .segment(text.slice(start - lead, start + 1))
    .containing(lead);
  if (owner && owner.index < lead) {
    return start;
  }
  let cursor = start;
  let count = 0;
  // Segment a growing window so a long reply is never copied into ICU per chunk.
  for (let span = INITIAL_WINDOW; count < maxGraphemes && cursor < text.length; span *= 2) {
    const windowEnd = Math.min(text.length, cursor + span);
    for (const { segment } of getGraphemeSegmenter().segment(text.slice(cursor, windowEnd))) {
      if (count >= maxGraphemes) {
        return cursor;
      }
      // The last cluster of a cut window may continue past it.
      if (cursor + segment.length === windowEnd && windowEnd < text.length) {
        break;
      }
      if (!WHITESPACE_GRAPHEME_RE.test(segment)) {
        return cursor;
      }
      cursor += segment.length;
      count += 1;
    }
  }
  return cursor;
}

/** Trims only whole trailing whitespace graphemes from a source prefix. */
export function trimEndWhitespaceGraphemes(text: string, end = text.length): string {
  if (!/\s/u.test(text.charAt(end - 1))) {
    return text.slice(0, end);
  }
  for (let span = INITIAL_WINDOW; ; span *= 2) {
    const from = Math.max(0, end - span);
    // Two extra code units reveal a mark that joins the whitespace across `end`.
    const segments = getGraphemeSegmenter().segment(text.slice(from, end + 2));
    let cursor = end - from;
    while (cursor > 0) {
      const cluster = segments.containing(cursor - 1);
      if (
        !cluster ||
        cluster.index + cluster.segment.length > cursor ||
        !WHITESPACE_GRAPHEME_RE.test(cluster.segment)
      ) {
        return text.slice(0, from + cursor);
      }
      // A cluster cut by the window start may be longer than it looks.
      if (cluster.index === 0 && from > 0) {
        break;
      }
      cursor = cluster.index;
    }
    if (cursor === 0) {
      return text.slice(0, from);
    }
  }
}
