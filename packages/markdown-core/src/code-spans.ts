import { scanFenceSpans, type FenceScanState, type FenceSpan } from "./fences.js";

/** Incremental inline-code scanner state carried across chunk boundaries. */
export type InlineCodeState = {
  /** Whether the current scan is inside an unterminated inline code span. */
  open: boolean;
  /** Backtick run length required to close the current inline code span. */
  ticks: number;
  /**
   * Length of a backtick run that ended exactly on the previous chunk boundary
   * and was therefore not classified yet: the next chunk may continue the run,
   * so opening/closing it early would treat one run as two. Zero when the
   * previous chunk did not end mid backtick run. Optional so existing
   * `{ open, ticks }` state literals remain valid.
   */
  pendingTicks?: number;
};

/** Creates the carry-forward state used when scanning inline code across chunks. */
export function createInlineCodeState(): InlineCodeState {
  return { open: false, ticks: 0, pendingTicks: 0 };
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
  let open = initialState.open;
  let ticks = initialState.ticks;
  let openStart = open ? 0 : -1;

  let i = 0;

  // Resolve a backtick run deferred from the previous chunk boundary. It may be
  // continued by leading backticks of this chunk, so combine both before
  // deciding whether the run opens or closes a span. Its delimiters live in the
  // previous chunk, so within this chunk the affected span starts at offset 0.
  let pending = initialState.pendingTicks ?? 0;
  if (pending > 0) {
    let lead = 0;
    while (lead < text.length && text[lead] === "`") {
      lead += 1;
    }
    const runLength = pending + lead;
    if (lead === text.length) {
      // The entire chunk continues the deferred run, so it may still grow: keep it
      // deferred. An already-open span is covered by the trailing span below; when
      // closed, emit a provisional span so these opening delimiters count as inside.
      if (!open && text.length > 0) {
        inlineSpans.push({ start: 0, end: text.length });
      }
      pending = runLength;
      i = text.length;
    } else {
      // A non-backtick followed, so the run is complete and can be classified now.
      if (!open) {
        open = true;
        ticks = runLength;
        openStart = 0;
      } else if (runLength === ticks) {
        if (lead > 0) {
          inlineSpans.push({ start: 0, end: lead });
        }
        open = false;
        ticks = 0;
        openStart = -1;
      }
      i = lead;
      pending = 0;
    }
  }

  // The scanner emits ordered, disjoint fences and the input cursor only advances.
  // Retire each fence once instead of searching all prior fences at every character.
  let fenceIndex = 0;
  while (i < text.length) {
    const fence = fenceSpans[fenceIndex];
    if (fence && i >= fence.start) {
      i = fence.end;
      fenceIndex += 1;
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

    // A run reaching the end of this chunk may continue in the next one, so defer
    // its classification instead of splitting it into two shorter runs. When the
    // span is currently open, the trailing `if (open)` span below already covers
    // these delimiters; when closed, emit a provisional span so this chunk still
    // reports the opening delimiters (and any content up to the boundary) as inside.
    if (i === text.length) {
      if (!open) {
        inlineSpans.push({ start: runStart, end: text.length });
      }
      pending = runLength;
      break;
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
    inlineState: { open, ticks, pendingTicks: pending },
    fenceState: nextFenceState,
    // Each scanner emits ordered, disjoint spans; inline spans can enclose fences.
    // Search separately so overlap between the lists cannot hide a containing span.
    isInside: (index: number) =>
      isInsideSpan(index, fenceSpans) || isInsideSpan(index, inlineSpans),
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
