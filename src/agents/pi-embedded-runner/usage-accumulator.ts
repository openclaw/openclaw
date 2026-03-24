import type { NormalizedUsage } from "../usage.js";

export type UsageAccumulator = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  /** Cache fields from the most recent API call (not accumulated). */
  lastCacheRead: number;
  lastCacheWrite: number;
  lastInput: number;
};

export const createUsageAccumulator = (): UsageAccumulator => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  total: 0,
  lastCacheRead: 0,
  lastCacheWrite: 0,
  lastInput: 0,
});

type MaybeUsage = NormalizedUsage | undefined;

const hasUsageValues = (usage: MaybeUsage): usage is NormalizedUsage =>
  !!usage &&
  [usage.input, usage.output, usage.cacheRead, usage.cacheWrite, usage.total].some(
    (value) => typeof value === "number" && Number.isFinite(value) && value > 0,
  );

export const mergeUsageIntoAccumulator = (target: UsageAccumulator, usage: MaybeUsage) => {
  if (!hasUsageValues(usage)) {
    return;
  }
  target.input += usage.input ?? 0;
  target.output += usage.output ?? 0;
  target.cacheRead += usage.cacheRead ?? 0;
  target.cacheWrite += usage.cacheWrite ?? 0;
  target.total +=
    usage.total ??
    (usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
  // Track the most recent API call's cache fields for accurate context-size reporting.
  // Accumulated cache totals inflate context size because each tool-call
  // round-trip reports cacheRead ≈ current_context_size, and summing N calls gives
  // N × context_size which gets clamped to contextWindow (e.g. 200k).
  target.lastCacheRead = usage.cacheRead ?? 0;
  target.lastCacheWrite = usage.cacheWrite ?? 0;
  target.lastInput = usage.input ?? 0;
};

/**
 * Convert a UsageAccumulator into a NormalizedUsage for cost/billing tracking.
 *
 * Returns **accumulated** input/cacheRead/cacheWrite/output so that downstream
 * cost estimation sees the full billed token counts for the entire turn, not
 * just the last API call.
 *
 * Context-size display should use `lastCallUsage` (the raw snapshot from the
 * final API call), which is computed separately and stored alongside this value.
 *
 * See: https://github.com/openclaw/openclaw/issues/53734
 */
/**
 * Extract a context-size snapshot from the accumulator using the last API
 * call's prompt-side fields. Use this as a fallback `lastCallUsage` when the
 * raw `lastAssistant` object is unavailable (e.g. retry-limit error paths).
 */
export const toLastCallUsage = (usage: UsageAccumulator): NormalizedUsage | undefined => {
  const hasValues = usage.lastInput > 0 || usage.lastCacheRead > 0 || usage.lastCacheWrite > 0;
  if (!hasValues && usage.output <= 0) {
    return undefined;
  }
  return {
    input: usage.lastInput || undefined,
    output: usage.output || undefined,
    cacheRead: usage.lastCacheRead || undefined,
    cacheWrite: usage.lastCacheWrite || undefined,
    total: usage.lastInput + usage.lastCacheRead + usage.lastCacheWrite + usage.output || undefined,
  };
};

export const toNormalizedUsage = (usage: UsageAccumulator): NormalizedUsage | undefined => {
  const hasUsage =
    usage.input > 0 ||
    usage.output > 0 ||
    usage.cacheRead > 0 ||
    usage.cacheWrite > 0 ||
    usage.total > 0;
  if (!hasUsage) {
    return undefined;
  }
  return {
    input: usage.input || undefined,
    output: usage.output || undefined,
    cacheRead: usage.cacheRead || undefined,
    cacheWrite: usage.cacheWrite || undefined,
    total: usage.total || undefined,
  };
};
