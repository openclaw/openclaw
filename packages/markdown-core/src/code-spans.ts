import { scanFenceSpans, type FenceScanState, type FenceSpan } from "./fences.js";

/** Incremental inline-code scanner state carried across chunk boundaries. */
export type InlineCodeState = {
  /** Whether the current scan is inside an unterminated inline code span. */
  open: boolean;
  /** Backtick run length required to close the current inline code span. */
  ticks: number;
  /**
   * A backtick run that ended the chunk with no character after it. The chunk had to classify
   * that run to answer its own queries, but the run may continue in the next chunk, so carry
   * its length together with the scanner state from before it and let the next scan decide.
   */
  pendingRun?: {
    /** Backticks seen at the end of the chunk. */
    ticks: number;
    /** Whether a span was already open when the run started. */
    open: boolean;
    /** Backtick run length the open span needs to close, as of the run's start. */
    requiredTicks: number;
  };
};

/** Creates the carry-forward state used when scanning inline code across chunks. */
export function createInlineCodeState(): InlineCodeState {
  return { open: false, ticks: 0 };
}

type CodeSpan = Pick<FenceSpan, "start" | "end">;

/** Builds a lookup for fenced and inline code spans while preserving scanner state. */
export function buildCodeSpanIndex(
  text: string,
  inlineState?: InlineCodeState,
  fenceState?: FenceScanState,
) {
  const { spans: fenceSpans, state: nextFenceState } = scanFenceSpans(text, fenceState);
  const initialState = inlineState ?? createInlineCodeState();
  const inlineSpans: CodeSpan[] = [];
  // A run the previous chunk ended inside is not a run of its own: resume the scan from the
  // state before that run and count its backticks as the prefix of this chunk's first run.
  const carriedRun = initialState.pendingRun;
  const carriedTicks = Math.max(0, carriedRun?.ticks ?? 0);
  let open = carriedRun ? carriedRun.open : initialState.open;
  let ticks = carriedRun ? (carriedRun.open ? carriedRun.requiredTicks : 0) : initialState.ticks;
  let openStart = open ? 0 : -1;
  let runStart = carriedTicks > 0 ? 0 : -1;
  let runLength = carriedTicks;
  let pendingRun: InlineCodeState["pendingRun"];

  // Spans are recorded against a scan prefixed with the carried ticks, so offsets are shifted
  // by them when a caller asks about this chunk.
  const classifyRun = (end: number) => {
    if (!open) {
      open = true;
      ticks = runLength;
      openStart = runStart;
    } else if (runLength === ticks) {
      inlineSpans.push({ start: openStart, end });
      open = false;
      ticks = 0;
      openStart = -1;
    }
    runLength = 0;
    runStart = -1;
  };

  let i = 0;
  // The scanner emits ordered, disjoint fences and the input cursor only advances.
  // Retire each fence once instead of searching all prior fences at every character.
  let fenceIndex = 0;
  while (i < text.length) {
    const fence = fenceSpans[fenceIndex];
    if (fence && i >= fence.start) {
      if (runLength > 0) {
        classifyRun(i + carriedTicks);
      }
      i = fence.end;
      fenceIndex += 1;
      continue;
    }

    if (text[i] !== "`") {
      if (runLength > 0) {
        classifyRun(i + carriedTicks);
      }
      i += 1;
      continue;
    }

    if (runLength === 0) {
      runStart = i + carriedTicks;
    }
    while (i < text.length && text[i] === "`") {
      runLength += 1;
      i += 1;
    }
    if (i < text.length && runLength > 0) {
      classifyRun(i + carriedTicks);
    }
  }

  // A run that ends the chunk is classified for this chunk's own queries, but it is only known
  // to be complete once a character follows it, so hand the next scan the state from before it.
  if (runLength > 0) {
    pendingRun = { ticks: runLength, open, requiredTicks: ticks };
    if (text.length > 0) {
      classifyRun(text.length + carriedTicks);
    }
  }

  if (open) {
    inlineSpans.push({ start: openStart, end: text.length + carriedTicks });
  }

  return {
    inlineState: { open, ticks, ...(pendingRun ? { pendingRun } : {}) },
    fenceState: nextFenceState,
    // Each scanner emits ordered, disjoint spans; inline spans can enclose fences.
    // Search separately so overlap between the lists cannot hide a containing span.
    isInside: (index: number) =>
      isInsideSpan(index, fenceSpans) || isInsideSpan(index + carriedTicks, inlineSpans),
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
