import { normalizeUsage, type NormalizedUsage, type UsageLike } from "../usage.js";

/**
 * Tracks both run-wide token totals and the exact latest provider-call usage.
 *
 * The accumulated fields feed billing/reporting for an attempt that may issue
 * several provider calls; the `last*` fields feed prompt-token and retry
 * metadata that must describe only the final model call.
 */
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

/** Creates an empty usage accumulator with all run-wide and last-call fields reset. */
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

/**
 * Adds one normalized provider-call usage snapshot to the run totals.
 *
 * Zero-only snapshots are ignored so an empty/no-usage call does not erase the
 * previous `last*` fields; usable snapshots update both accumulated totals and
 * the latest-call mirror.
 */
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

/** Converts accumulated run-wide usage into the normalized payload shape. */
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

/** Converts only the latest provider-call snapshot into the normalized payload shape. */
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

/**
 * Resolves latest-call usage from the assistant payload, falling back to the
 * accumulator when the provider omitted or returned unusable usage metadata.
 */
export const resolveLastCallUsage = (
  rawUsage: UsageLike | null | undefined,
  usageAccumulator: UsageAccumulator,
): NormalizedUsage | undefined => normalizeUsage(rawUsage) ?? toLastCallUsage(usageAccumulator);
