export type ScriptCoverageFunctions = readonly {
  ranges: readonly { startOffset: number; endOffset: number; count: number }[];
}[];

/** V8 offsets are UTF-16; nested block counts override their containing function. */
export function scriptExecutionMask(length: number, functions: ScriptCoverageFunctions) {
  const executed = new Uint8Array(length);
  const ranges = functions
    .flatMap((fn) => fn.ranges)
    .toSorted(
      (left, right) => right.endOffset - right.startOffset - (left.endOffset - left.startOffset),
    );
  for (const range of ranges) {
    executed.fill(range.count > 0 ? 1 : 0, range.startOffset, range.endOffset);
  }
  return executed;
}
