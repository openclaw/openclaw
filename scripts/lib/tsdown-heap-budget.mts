// Build heap admission facts that tsdown-build decides and its build children consume.
// Kept apart from tsdown-build so a tsdown plugin process can read them without its import graph.

/** tsdown-build hands every build child its admitted heap here; operators may also set it. */
export const TSDOWN_MAX_OLD_SPACE_MB_ENV = "OPENCLAW_TSDOWN_MAX_OLD_SPACE_MB";
export const DEFAULT_TSDOWN_MAX_OLD_SPACE_MB = 12288;

/**
 * Native allocations (rolldown, the Go declaration compiler) are outside the JS heap, so
 * parallel native work runs only when memory admitted the uncapped default heap.
 */
export function tsdownBudgetAdmitsParallelNativeWork(maxOldSpaceMb: number) {
  return maxOldSpaceMb >= DEFAULT_TSDOWN_MAX_OLD_SPACE_MB;
}
