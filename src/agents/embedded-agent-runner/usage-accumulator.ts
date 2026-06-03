import { normalizeUsage, type NormalizedUsage, type UsageLike } from "../usage.js";

/** Aggregates per-call usage while preserving the final provider-reported call snapshot. */
export type UsageAccumulator = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoningTokens: number;
  total: number;
  /** Exact usage snapshot from the most recent API call. */
  lastInput: number;
  lastOutput: number;
  lastCacheRead: number;
  lastCacheWrite: number;
  lastReasoningTokens: number;
  lastTotal: number;
};

/** Creates the zeroed usage collector shared across fallback/model-switch attempts. */
export const createUsageAccumulator = (): UsageAccumulator => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  reasoningTokens: 0,
  total: 0,
  lastInput: 0,
  lastOutput: 0,
  lastCacheRead: 0,
  lastCacheWrite: 0,
  lastReasoningTokens: 0,
  lastTotal: 0,
});

type MaybeUsage = NormalizedUsage | undefined;

const hasUsageValues = (usage: MaybeUsage): usage is NormalizedUsage => {
  if (!usage) {
    return false;
  }
  return [
    usage.input,
    usage.output,
    usage.cacheRead,
    usage.cacheWrite,
    usage.reasoningTokens,
    usage.total,
  ].some((value) => typeof value === "number" && Number.isFinite(value) && value > 0);
};

/** Adds one normalized provider usage report and records it as the latest call snapshot. */
export const mergeUsageIntoAccumulator = (target: UsageAccumulator, usage: MaybeUsage) => {
  if (!hasUsageValues(usage)) {
    return;
  }
  const callTotal =
    usage.total ??
    (usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
  target.input += usage.input ?? 0;
  target.output += usage.output ?? 0;
  target.cacheRead += usage.cacheRead ?? 0;
  target.cacheWrite += usage.cacheWrite ?? 0;
  target.reasoningTokens += usage.reasoningTokens ?? 0;
  target.total += callTotal;
  target.lastInput = usage.input ?? 0;
  target.lastOutput = usage.output ?? 0;
  target.lastCacheRead = usage.cacheRead ?? 0;
  target.lastCacheWrite = usage.cacheWrite ?? 0;
  target.lastReasoningTokens = usage.reasoningTokens ?? 0;
  target.lastTotal = callTotal;
};

/** Converts accumulated totals into the billing/status usage shape. */
export const toNormalizedUsage = (usage: UsageAccumulator): NormalizedUsage | undefined => {
  const hasUsage =
    usage.input > 0 ||
    usage.output > 0 ||
    usage.cacheRead > 0 ||
    usage.cacheWrite > 0 ||
    usage.reasoningTokens > 0 ||
    usage.total > 0;
  if (!hasUsage) {
    return undefined;
  }
  return {
    input: usage.input || undefined,
    output: usage.output || undefined,
    cacheRead: usage.cacheRead || undefined,
    cacheWrite: usage.cacheWrite || undefined,
    ...(usage.reasoningTokens > 0 ? { reasoningTokens: usage.reasoningTokens } : {}),
    total: usage.total || undefined,
  };
};

/** Converts only the most recent API-call snapshot into the result usage shape. */
export const toLastCallUsage = (usage: UsageAccumulator): NormalizedUsage | undefined => {
  const hasUsage =
    usage.lastInput > 0 ||
    usage.lastOutput > 0 ||
    usage.lastCacheRead > 0 ||
    usage.lastCacheWrite > 0 ||
    usage.lastReasoningTokens > 0 ||
    usage.lastTotal > 0;
  if (!hasUsage) {
    return undefined;
  }
  return {
    input: usage.lastInput || undefined,
    output: usage.lastOutput || undefined,
    cacheRead: usage.lastCacheRead || undefined,
    cacheWrite: usage.lastCacheWrite || undefined,
    ...(usage.lastReasoningTokens > 0 ? { reasoningTokens: usage.lastReasoningTokens } : {}),
    total: usage.lastTotal || undefined,
  };
};

/** Prefers raw assistant usage when present, falling back to the accumulator's last call. */
export const resolveLastCallUsage = (
  rawUsage: UsageLike | null | undefined,
  usageAccumulator: UsageAccumulator,
): NormalizedUsage | undefined => normalizeUsage(rawUsage) ?? toLastCallUsage(usageAccumulator);
