// Markdown Core module implements code spans behavior.
import { scanFenceSpans, type FenceScanState, type FenceSpan } from "./fences.js";

/** Incremental inline-code scanner state carried across chunk boundaries. */
export type InlineCodeState = {
  /** Whether the current scan is inside an unterminated inline code span. */
  open: boolean;
  /** Backtick run length required to close the current inline code span. */
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

type BacktickRun = {
  start: number;
  end: number;
  length: number;
  escaped: boolean;
};

type CodeSpanIndex = {
  /** Inline-code state to carry into the next streamed chunk. */
  inlineState: InlineCodeState;
  /** Fenced-code state to carry into the next streamed chunk. */
  fenceState: FenceScanState;
  /** True when an offset is inside fenced code or inline code. */
  isInside: (index: number) => boolean;
};

/** Builds a lookup for fenced and inline code spans while preserving scanner state. */
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

/** Parses complete fenced and inline code spans using matching backtick delimiters. */
export function parseCodeSpans(text: string): Array<[number, number]> {
  const fenceSpans = scanFenceSpans(text).spans;
  const inlineSpans = parseCompleteInlineCodeSpans(text, fenceSpans);
  return [
    ...fenceSpans.map((span): [number, number] => [span.start, span.end]),
    ...inlineSpans,
  ].toSorted((left, right) => left[0] - right[0]);
}

function parseCompleteInlineCodeSpans(
  text: string,
  fenceSpans: FenceSpan[],
): Array<[number, number]> {
  const runs: BacktickRun[] = [];
  let index = 0;
  while (index < text.length) {
    const fence = findFenceSpanAtInclusive(fenceSpans, index);
    if (fence) {
      index = fence.end;
      continue;
    }
    if (text[index] !== "`") {
      index += 1;
      continue;
    }
    const start = index;
    while (text[index] === "`") {
      index += 1;
    }
    let precedingBackslashes = 0;
    for (let cursor = start - 1; cursor >= 0 && text[cursor] === "\\"; cursor -= 1) {
      precedingBackslashes += 1;
    }
    runs.push({
      start,
      end: index,
      length: index - start,
      escaped: precedingBackslashes % 2 === 1,
    });
  }

  const spans: Array<[number, number]> = [];
  let openerIndex = 0;
  while (openerIndex < runs.length) {
    const opener = runs[openerIndex];
    if (!opener) {
      break;
    }
    if (opener.escaped) {
      openerIndex += 1;
      continue;
    }
    let closerIndex = openerIndex + 1;
    while (closerIndex < runs.length && runs[closerIndex]?.length !== opener.length) {
      closerIndex += 1;
    }
    const closer = runs[closerIndex];
    if (!closer) {
      openerIndex += 1;
      continue;
    }
    spans.push([opener.start, closer.end]);
    openerIndex = closerIndex + 1;
  }
  return spans;
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
