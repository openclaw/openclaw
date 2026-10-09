/**
 * Carries fence state so streamed tool-call candidates avoid quadratic Markdown reparsing.
 * Answers only proven fence ownership; callers must fully parse every undefined verdict.
 */

export type ProtectionScanState = {
  fenceChar: "`" | "~" | undefined;
  fenceLength: number;
  /** Unmodeled paragraph syntax; cleared by a blank line. */
  paragraphAmbiguous: boolean;
  /** An unclassified delimiter makes fence parity permanently unknown. */
  structuralUnknown: boolean;
  /** Trailing partial line; block structure is only decidable on whole lines. */
  partialLine: string;
};

export function createProtectionScanState(): ProtectionScanState {
  return {
    fenceChar: undefined,
    fenceLength: 0,
    paragraphAmbiguous: false,
    structuralUnknown: false,
    partialLine: "",
  };
}

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;
/** Blank means spaces and tabs only; Unicode spaces do not end a Markdown block. */
const BLANK_LINE = /^[ \t]*$/;
// This LF-only tracker must defer bare CR and split CRLF to the full CommonMark parser.
const BARE_CARRIAGE_RETURN = /\r(?!\n)/;
/** A fence-length delimiter run outside a fence that did not open one at column 0. */
const UNCLASSIFIED_FENCE_DELIMITER = /`{3,}|~{3,}/;
// CommonMark expands tabs to four columns. Blank lines are handled before this test.
const UNMODELED_BLOCK_START = /^(?: {0,3}(?:>|[-*+](?:\s|$)|\d{1,9}[.)](?:\s|$))| {4,}| *\t)/;

/** Applies one whole line (newline excluded) to the carried state. */
function applyLine(state: ProtectionScanState, line: string): void {
  if (state.structuralUnknown) {
    return;
  }
  if (state.fenceChar) {
    // Unicode whitespace cannot close a fence; accepting it would scrub literal content.
    const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
    const run = close?.[1];
    if (run && run[0] === state.fenceChar && run.length >= state.fenceLength) {
      state.fenceChar = undefined;
      state.fenceLength = 0;
    }
    return;
  }
  if (BLANK_LINE.test(line)) {
    state.paragraphAmbiguous = false;
    return;
  }
  const open = FENCE_OPEN.exec(line);
  const marker = open?.[1];
  if (marker) {
    // Container-owned fences and backticks in backtick info strings require the full parser.
    const infoString = line.slice(open[0].length);
    if (
      state.paragraphAmbiguous ||
      open[0].length !== marker.length ||
      (marker[0] === "`" && infoString.includes("`"))
    ) {
      state.structuralUnknown = true;
      return;
    }
    state.fenceChar = marker[0] === "~" ? "~" : "`";
    state.fenceLength = marker.length;
    return;
  }
  if (UNCLASSIFIED_FENCE_DELIMITER.test(line)) {
    state.structuralUnknown = true;
    return;
  }
  if (line.includes("`") || UNMODELED_BLOCK_START.test(line)) {
    state.paragraphAmbiguous = true;
  }
}

/** Feeds appended visible text into the carried state. */
export function advanceProtectionScanState(state: ProtectionScanState, text: string): void {
  if (!text) {
    return;
  }
  if (BARE_CARRIAGE_RETURN.test(text)) {
    state.structuralUnknown = true;
    return;
  }
  // Search new bytes before joining the newline-free partial, keeping long lines linear.
  let newline = text.indexOf("\n");
  if (newline === -1) {
    state.partialLine += text;
    return;
  }
  let line = (state.partialLine + text.slice(0, newline)).replace(/\r$/, "");
  applyLine(state, line);
  let cursor = newline + 1;
  newline = text.indexOf("\n", cursor);
  while (newline !== -1) {
    line = text.slice(cursor, newline).replace(/\r$/, "");
    applyLine(state, line);
    cursor = newline + 1;
    newline = text.indexOf("\n", cursor);
  }
  state.partialLine = text.slice(cursor);
}

/** Resolves candidate protection relative to incoming without mutating carried state. */
export function resolveProtectionFastPath(
  carried: ProtectionScanState,
  incoming: string,
): ((offset: number) => boolean) | undefined {
  if (carried.paragraphAmbiguous || carried.structuralUnknown) {
    return undefined;
  }
  if (BARE_CARRIAGE_RETURN.test(incoming)) {
    return undefined;
  }
  const state = { ...carried };
  const lineStarts: Array<[start: number, isProtected: boolean]> = [];
  let index = 0;
  for (;;) {
    if (index >= incoming.length && !state.partialLine) {
      // A final newline has no queryable tail and does not require a full parse.
      break;
    }
    const newline = incoming.indexOf("\n", index);
    const complete = newline !== -1;
    const line =
      `${state.partialLine}${incoming.slice(index, complete ? newline : undefined)}`.replace(
        /\r$/,
        "",
      );
    // Offsets are reported relative to `incoming`; a carried partial line began before it.
    const lineStartAbsolute = index - state.partialLine.length;
    if (state.fenceChar) {
      // Fences own their delimiter lines even before the line completes.
      lineStarts.push([lineStartAbsolute, true]);
    } else if (!complete) {
      // An unfinished line can still acquire code ownership.
      return undefined;
    } else {
      const probe = { ...state };
      applyLine(probe, line);
      if (probe.paragraphAmbiguous || probe.structuralUnknown) {
        return undefined;
      }
      lineStarts.push([lineStartAbsolute, Boolean(probe.fenceChar)]);
    }
    if (!complete) {
      break;
    }
    applyLine(state, line);
    if (state.paragraphAmbiguous || state.structuralUnknown) {
      return undefined;
    }
    state.partialLine = "";
    index = newline + 1;
  }
  // findPotentialCallStart queries non-decreasing offsets; retain a cursor to keep lookup linear.
  let cursor = -1;
  let isProtected = false;
  return (offset: number) => {
    // Candidate offsets sit at a line start; the nearest preceding start owns the verdict.
    while (cursor + 1 < lineStarts.length) {
      const next = lineStarts[cursor + 1];
      if (next === undefined || next[0] > offset) {
        break;
      }
      cursor += 1;
      isProtected = next[1];
    }
    return isProtected;
  };
}
