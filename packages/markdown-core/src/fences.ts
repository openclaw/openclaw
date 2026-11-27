/** Markdown fenced-code block span with the opener data needed to reopen it. */
export type FenceSpan = {
  start: number;
  end: number;
  openLine: string;
  marker: string;
  indent: string;
};

type OpenFence = Pick<FenceSpan, "marker" | "indent" | "openLine"> & {
  markerChar: string;
  markerLen: number;
};

/** Streaming fence scanner state carried across partial markdown chunks. */
export type FenceScanState = {
  atLineStart?: boolean;
  open?: OpenFence;
  /** Rescan an unfinished delimiter from the state before its line. */
  pendingLine?: { text: string; open?: OpenFence };
};

// LF alone defines scanner lines; consume CRLF's CR for raw offsets, not opener text.
const FENCE_LINE_RE = /(?:^|\n)( {0,3})(`{3,}|~{3,})([^\r\n\u2028\u2029]*)\r?(?=\n|$)/g;
const SINGLE_LINE_FENCE_RE = new RegExp(FENCE_LINE_RE, "gy");
// The next chunk can extend a marker run or add text that disqualifies a closing fence.
const PARTIAL_MARKER_LINE_RE = /^ {0,3}(?:(?:`+|~+)[ \t]*\r?)?$/u;

/** Scans fenced-code spans incrementally so chunking can carry an open fence forward. */
export function scanFenceSpans(
  buffer: string,
  state?: FenceScanState,
): { spans: FenceSpan[]; state: FenceScanState } {
  const spans: FenceSpan[] = [];
  // Rejoin the indent or leading markers that ended the previous chunk so the boundary
  // cannot move a fence line out of reach. Reported offsets stay in this buffer's space.
  const pending = state?.pendingLine;
  const carried = pending?.text ?? "";
  const scanText = carried ? `${carried}${buffer}` : buffer;
  const startsAtLineStart = carried.length > 0 || (state?.atLineStart ?? true);
  const toBufferOffset = (index: number) => Math.max(0, index - carried.length);
  let open = pending ? pending.open : state?.open;
  let openStart = 0;
  const lastLineStart = scanText.lastIndexOf("\n") + 1;
  let openBeforeLastLine = open;
  let openedOnLastLine = false;

  // Without LF, only offset zero can be a fence. Sticky matching skips long prose,
  // including inline marker literals; matchAll leaves both shared patterns untouched.
  const pattern = lastLineStart > 0 ? FENCE_LINE_RE : SINGLE_LINE_FENCE_RE;
  for (const match of scanText.matchAll(pattern)) {
    const [, indent, marker, trailing] = match;
    if (indent === undefined || marker === undefined || trailing === undefined) {
      continue;
    }
    const start = match.index + (match[0].startsWith("\n") ? 1 : 0);
    if (start === 0 && !startsAtLineStart) {
      continue;
    }
    const markerChar = marker.charAt(0);
    const markerLen = marker.length;
    if (!open) {
      // CommonMark forbids backticks in a backtick fence info string.
      if (markerChar === "`" && trailing.includes("`")) {
        continue;
      }
      openStart = start;
      openedOnLastLine = start === lastLineStart;
      open = {
        markerChar,
        markerLen,
        openLine: `${indent}${marker}${trailing}`,
        marker,
        indent,
      };
    } else if (
      open.markerChar === markerChar &&
      markerLen >= open.markerLen &&
      /^[ \t]*$/.test(trailing)
    ) {
      // CommonMark permits only spaces or tabs after a closing fence. A marker line carrying
      // other trailing text is code content, not a close, so it must not end the block.
      spans.push({
        start: toBufferOffset(openStart),
        end: toBufferOffset(match.index + match[0].length),
        openLine: open.openLine,
        marker: open.marker,
        indent: open.indent,
      });
      open = undefined;
    }
    if (start < lastLineStart) {
      openBeforeLastLine = open;
    }
  }

  if (open) {
    spans.push({
      start: toBufferOffset(openStart),
      end: buffer.length,
      openLine: open.openLine,
      marker: open.marker,
      indent: open.indent,
    });
  }

  const atLineStart = buffer.length === 0 ? (state?.atLineStart ?? true) : buffer.endsWith("\n");
  const lastLine = scanText.slice(lastLineStart);
  const pendingLine =
    (lastLineStart > 0 || startsAtLineStart) &&
    lastLine.length > 0 &&
    (openedOnLastLine || PARTIAL_MARKER_LINE_RE.test(lastLine))
      ? { text: lastLine, ...(openBeforeLastLine ? { open: openBeforeLastLine } : {}) }
      : undefined;
  const nextState: FenceScanState = {
    atLineStart,
    ...(pendingLine ? { pendingLine } : {}),
    ...(open ? { open } : {}),
  };
  return { spans, state: nextState };
}

/** Parses all fenced-code spans in a complete markdown buffer. */
export function parseFenceSpans(buffer: string): FenceSpan[] {
  return scanFenceSpans(buffer).spans;
}

/** Looks up the span containing an offset; spans must be sorted by start offset. */
export function findFenceSpanAt<T extends Pick<FenceSpan, "start" | "end">>(
  spans: readonly T[],
  index: number,
): T | undefined {
  let low = 0;
  let high = spans.length - 1;

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const span = spans[mid];
    if (!span) {
      break;
    }
    if (index <= span.start) {
      high = mid - 1;
      continue;
    }
    if (index >= span.end) {
      low = mid + 1;
      continue;
    }
    return span;
  }

  return undefined;
}

/** True when a chunk boundary would not split any of the given spans. */
export function isSafeFenceBreak(
  spans: readonly Pick<FenceSpan, "start" | "end">[],
  index: number,
): boolean {
  return !findFenceSpanAt(spans, index);
}
