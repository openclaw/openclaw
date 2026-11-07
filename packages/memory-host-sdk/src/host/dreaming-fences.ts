// Managed dreaming ranges in memory files are scratchwork, not durable
// content. This module is the single owner of the fence policy: indexing and
// promotion rehydration both consume it so the two boundaries cannot drift.
//
// A fence runs from a `<!-- openclaw:dreaming:<phase>:start -->` marker line
// through the matching `:end -->` marker line, inclusive. Marker lines are
// managed content too. A start marker with no end marker manages the rest of
// the file, matching how the dreaming writers recover from a crashed phase.

const DREAMING_FENCE_START_RE = /<!--\s*openclaw:dreaming:[a-z][a-z0-9-]*:start\s*-->/i;
const DREAMING_FENCE_END_RE = /<!--\s*openclaw:dreaming:[a-z][a-z0-9-]*:end\s*-->/i;

/** True when the line is a fence marker (start or end, any phase). */
export function isDreamingFenceMarkerLine(line: string): boolean {
  return DREAMING_FENCE_START_RE.test(line) || DREAMING_FENCE_END_RE.test(line);
}

/** Per-line managed state for a document already split into lines. */
function dreamingFenceLineStates(lines: string[]): boolean[] {
  let insideFence = false;
  return lines.map((line) => {
    const isStart = DREAMING_FENCE_START_RE.test(line);
    const isEnd = DREAMING_FENCE_END_RE.test(line);
    const managed = insideFence || isStart || isEnd;
    if (isStart || isEnd) {
      insideFence = isStart;
    }
    return managed;
  });
}

/** Managed ranges as 1-indexed inclusive line spans, in document order. */
export function findDreamingFenceRanges(
  lines: string[],
): Array<{ startLine: number; endLine: number }> {
  const states = dreamingFenceLineStates(lines);
  const ranges: Array<{ startLine: number; endLine: number }> = [];
  let rangeStart: number | undefined;
  for (let index = 0; index < states.length; index += 1) {
    if (states[index] && rangeStart === undefined) {
      rangeStart = index + 1;
    }
    if (!states[index] && rangeStart !== undefined) {
      ranges.push({ startLine: rangeStart, endLine: index });
      rangeStart = undefined;
    }
  }
  if (rangeStart !== undefined) {
    ranges.push({ startLine: rangeStart, endLine: states.length });
  }
  return ranges;
}

/** True when any line of the 1-indexed inclusive range is managed content. */
export function lineRangeOverlapsDreamingFence(
  lines: string[],
  startLine: number,
  endLine: number,
): boolean {
  if (lines.length === 0) {
    return false;
  }
  const safeStart = Math.max(1, Math.min(startLine, lines.length));
  const safeEnd = Math.max(safeStart, Math.min(endLine, lines.length));
  const states = dreamingFenceLineStates(lines);
  for (let index = safeStart - 1; index < safeEnd; index += 1) {
    if (states[index]) {
      return true;
    }
  }
  return false;
}

/**
 * Replace every managed line with an empty line, preserving the line count
 * so surviving content keeps its original line numbers and citations.
 * Returns the input unchanged when the document holds no fence.
 */
export function blankDreamingFencedRanges(content: string): string {
  if (!content.includes("openclaw:dreaming:")) {
    return content;
  }
  const lines = content.split("\n");
  const states = dreamingFenceLineStates(lines);
  if (!states.some(Boolean)) {
    return content;
  }
  return lines.map((line, index) => (states[index] ? "" : line)).join("\n");
}
