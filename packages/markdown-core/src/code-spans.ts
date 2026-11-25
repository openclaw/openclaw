import { scanFenceSpans, type FenceScanState, type FenceSpan } from "./fences.js";

/** Incremental inline-code scanner state carried across chunk boundaries. */
export type InlineCodeState = {
  /** Whether the current scan is inside an unterminated inline code span. */
  open: boolean;
  /** Backtick run length required to close the current inline code span. */
  ticks: number;
  /** Whether the previous chunk ended in prose with an unpaired backslash. */
  escaped?: boolean;
  /** Inline cursor before the unfinished delimiter line, if it needs to be reclassified. */
  beforePendingFence?: Pick<InlineCodeState, "open" | "ticks" | "escaped">;
};

/** Creates the carry-forward state used when scanning inline code across chunks. */
export function createInlineCodeState(): InlineCodeState {
  return { open: false, ticks: 0 };
}

type CodeSpan = Pick<FenceSpan, "start" | "end">;

/** Builds a lookup for fenced and inline code spans while preserving scanner state. */
export function buildCodeSpanIndex(
  buffer: string,
  inlineState?: InlineCodeState,
  fenceState?: FenceScanState,
) {
  // A carried marker may switch between inline and fenced code. Replay both
  // scanners from the same line boundary before classifying this buffer.
  const carried = fenceState?.pendingLine;
  const text = carried ? carried.text + buffer : buffer;
  const offset = carried?.text.length ?? 0;
  const { spans: fenceSpans, state: nextFenceState } = scanFenceSpans(
    text,
    carried ? { atLineStart: true, open: carried.open } : fenceState,
  );
  const initialState =
    (carried ? (inlineState?.beforePendingFence ?? inlineState) : inlineState) ??
    createInlineCodeState();
  const pendingStart = nextFenceState.pendingLine
    ? text.length - nextFenceState.pendingLine.text.length
    : -1;
  let beforePendingFence: InlineCodeState["beforePendingFence"];
  const inlineSpans: CodeSpan[] = [];
  let open = initialState.open;
  let ticks = initialState.ticks;
  let openStart = open ? 0 : -1;
  // Outside code, a backslash escapes the next backtick (CommonMark); inside code it is literal.
  let escaped = !open && initialState.escaped === true;

  let i = 0;
  // The scanner emits ordered, disjoint fences and the input cursor only advances.
  // Retire each fence once instead of searching all prior fences at every character.
  let fenceIndex = 0;
  while (i < text.length) {
    if (pendingStart >= 0 && i >= pendingStart && !beforePendingFence) {
      beforePendingFence = { open, ticks, escaped };
    }
    const fence = fenceSpans[fenceIndex];
    if (fence && i >= fence.start) {
      i = fence.end;
      fenceIndex += 1;
      escaped = false;
      continue;
    }

    if (escaped) {
      escaped = false;
      // An escaped backtick is literal, and an escaped backslash cannot escape what follows.
      if (text[i] === "`" || text[i] === "\\") {
        i += 1;
        continue;
      }
    }
    if (text[i] === "\\" && !open) {
      escaped = true;
      i += 1;
      continue;
    }
    if (text[i] !== "`") {
      i += 1;
      continue;
    }

    const runStart = i;
    let runLength = 0;
    while (i < text.length && text[i] === "`") {
      runLength += 1;
      i += 1;
    }

    if (!open) {
      open = true;
      ticks = runLength;
      openStart = runStart;
      continue;
    }

    if (runLength === ticks) {
      inlineSpans.push({ start: openStart, end: i });
      open = false;
      ticks = 0;
      openStart = -1;
    }
  }

  if (open) {
    inlineSpans.push({ start: openStart, end: text.length });
  }

  return {
    inlineState: {
      open,
      ticks,
      ...(escaped ? { escaped } : {}),
      ...(pendingStart >= 0
        ? { beforePendingFence: beforePendingFence ?? { open, ticks, escaped } }
        : {}),
    },
    fenceState: nextFenceState,
    // Each scanner emits ordered, disjoint spans; inline spans can enclose fences.
    // Search separately so overlap between the lists cannot hide a containing span.
    isInside: (index: number) =>
      index >= 0 &&
      index < buffer.length &&
      (isInsideSpan(offset + index, fenceSpans) || isInsideSpan(offset + index, inlineSpans)),
  };
}

function isInsideSpan(index: number, spans: CodeSpan[]): boolean {
  let low = 0;
  let high = spans.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const span = spans[middle];
    if (!span) {
      return false;
    }
    if (index >= span.end) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  const span = spans[low];
  return span !== undefined && index >= span.start && index < span.end;
}
