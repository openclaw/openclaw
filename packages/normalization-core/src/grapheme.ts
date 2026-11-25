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
  return graphemeChunkEndFinder(text, false)(start, maxEnd, preferredEnd, allowPartial);
}

// Full-source random lookup is only needed after an arbitrary start or a forced partial cut.
// A bit per UTF-16 offset and one preceding boundary per word keep that index proportional
// to input length, including both single-unit text and a single enormous cluster.
function indexGraphemeBoundaries(text: string) {
  const starts = new Uint32Array(Math.ceil(text.length / 32));
  for (const { index } of getGraphemeSegmenter().segment(text)) {
    const word = Math.floor(index / 32);
    starts[word] = (starts[word] ?? 0) | (1 << (index % 32));
  }
  const preceding = new Uint32Array(starts.length);
  let last = 0;
  for (const [word, bits] of starts.entries()) {
    preceding[word] = last;
    if (bits !== 0) {
      last = word * 32 + 31 - Math.clz32(bits);
    }
  }
  return (offset: number) => {
    const word = Math.floor(offset / 32);
    const throughOffset = 0xffffffff >>> (31 - (offset & 31));
    const bits = (starts[word] ?? 0) & throughOffset;
    return bits === 0 ? (preceding[word] ?? 0) : word * 32 + 31 - Math.clz32(bits);
  };
}

/** Owns the Unicode context for repeated cuts of the same original source. */
export function createGraphemeChunkEndFinder(text: string) {
  return graphemeChunkEndFinder(text, true);
}

function graphemeChunkEndFinder(text: string, reuse: boolean) {
  let lastBoundary: number | undefined = 0;
  let indexed: ReturnType<typeof indexGraphemeBoundaries> | undefined;
  return (start: number, maxEnd: number, preferredEnd = maxEnd, allowPartial = true): number => {
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

    const before = text.charCodeAt(preferred - 1);
    const after = text.charCodeAt(preferred);
    if (
      Number.isInteger(preferred) &&
      before <= 0x7f &&
      after <= 0x7f &&
      !(before === 0x0d && after === 0x0a)
    ) {
      lastBoundary = preferred;
      return preferred;
    }

    // A partial cut can land inside a cluster. Restart ICU only at a known source boundary;
    // restarting between regional indicators changes which subsequent flags get paired.
    const from = start === 0 ? 0 : (lastBoundary ?? 0);
    if (
      reuse &&
      start !== 0 &&
      (lastBoundary === undefined || from > start || start - from > hardEnd - start)
    ) {
      indexed ??= indexGraphemeBoundaries(text);
    }
    const segments = indexed
      ? undefined
      : getGraphemeSegmenter().segment(text.slice(from, hardEnd + 2));
    const boundaryAt =
      indexed ??
      ((position: number) =>
        from + (segments?.containing(position - from)?.index ?? position - from));
    let end = boundaryAt(preferred);
    if (end <= start && preferred < hardEnd) {
      end = hardEnd === text.length ? hardEnd : boundaryAt(hardEnd);
    }
    if (end > start) {
      lastBoundary = end;
      return end;
    }
    if (allowPartial) {
      // A subsequent cut inside this cluster needs the original context. A one-off lookup
      // still finishes here without indexing the unexamined remainder of its input.
      lastBoundary = undefined;
      return avoidTrailingHighSurrogateBreak(text, start, hardEnd);
    }
    return start;
  };
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
    let windowEnd = Math.min(text.length, cursor + span);
    // A clipped supplementary mark would make its preceding whitespace look standalone.
    if ((text.codePointAt(windowEnd - 1) ?? 0) > 0xffff) {
      windowEnd += 1;
    }
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
    let from = Math.max(0, end - span);
    // Keep supplementary Prepend characters intact when deciding who owns the first space.
    if ((text.codePointAt(from - 1) ?? 0) > 0xffff) {
      from -= 1;
    }
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
