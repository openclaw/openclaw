import { scanFenceSpans, type FenceScanState, type FenceSpan } from "./fences.js";

/** Incremental inline-code scanner state carried between streamed chunks. */
export type InlineCodeState = {
  /** True when a previous chunk opened a backtick run that has not closed yet. */
  open: boolean;
  /** Backtick run length required to close the current inline-code span. */
  ticks: number;
};

/** Creates the carry-forward state used when scanning inline code across chunks. */
export function createInlineCodeState(): InlineCodeState {
  return { open: false, ticks: 0 };
}

type InlineCodeSpansResult = {
  spans: Array<[number, number]>;
  state: InlineCodeState;
};

type CodeSpanIndex = {
  inlineState: InlineCodeState;
  fenceState: FenceScanState;
  isInside: (index: number) => boolean;
};

/** Builds a zero-based code-region lookup for fenced and inline spans, plus next scanner state. */
export function buildCodeSpanIndex(
  text: string,
  inlineState?: InlineCodeState,
  fenceState?: FenceScanState,
): CodeSpanIndex {
  const { spans: fenceSpans, state: nextFenceState } = scanFenceSpans(text, fenceState);
  const startState = inlineState
    ? { open: inlineState.open, ticks: inlineState.ticks }
    : createInlineCodeState();
  const { spans: inlineSpans, state: nextInlineState } = parseInlineCodeSpans(
    text,
    fenceSpans,
    startState,
  );

  return {
    inlineState: nextInlineState,
    fenceState: nextFenceState,
    isInside: (index: number) =>
      isInsideFenceSpan(index, fenceSpans) || isInsideInlineSpan(index, inlineSpans),
  };
}

function parseInlineCodeSpans(
  text: string,
  fenceSpans: FenceSpan[],
  initialState: InlineCodeState,
): InlineCodeSpansResult {
  const spans: Array<[number, number]> = [];
  let open = initialState.open;
  let ticks = initialState.ticks;
  let openStart = open ? 0 : -1;

  let i = 0;
  while (i < text.length) {
    const fence = findFenceSpanAtInclusive(fenceSpans, i);
    if (fence) {
      // Fenced code owns its full range; inline backticks inside it must not change state.
      i = fence.end;
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
      spans.push([openStart, i]);
      open = false;
      ticks = 0;
      openStart = -1;
    }
  }

  if (open) {
    // Treat an unfinished span as code through chunk end so partial tags stay protected.
    spans.push([openStart, text.length]);
  }

  return {
    spans,
    state: { open, ticks },
  };
}

function findFenceSpanAtInclusive(spans: FenceSpan[], index: number): FenceSpan | undefined {
  return spans.find((span) => index >= span.start && index < span.end);
}

function isInsideFenceSpan(index: number, spans: FenceSpan[]): boolean {
  return spans.some((span) => index >= span.start && index < span.end);
}

function isInsideInlineSpan(index: number, spans: Array<[number, number]>): boolean {
  return spans.some(([start, end]) => index >= start && index < end);
}
