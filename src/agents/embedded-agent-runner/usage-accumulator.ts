import { hasBillableUsage, USAGE_COST_COMPONENTS } from "../usage.js";
import type { NormalizedUsage } from "../usage.js";
import type { EmbeddedAgentMeta } from "./types.js";

export type UsageAccumulator = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cacheReadReported?: true;
  cacheWriteReported?: true;
  cacheWrite1h?: number;
  cacheWrite5m?: number;
  reasoningTokens: number;
  total: number;
  usageReport?: NormalizedUsage["usageReport"];
  /** Undefined means unobserved; any missing call price makes the complete sum unavailable. */
  cost: NormalizedUsage["cost"] | "unavailable";
  costStatus?: NormalizedUsage["costStatus"];
  /** Counts every attempt, including retries. */
  assistantTurns: number;
  /** Omitted until an attempt reports a tool-search/code-mode catalog. */
  bridgeCalls?: EmbeddedAgentMeta["bridgeCalls"];
};

export const createUsageAccumulator = (): UsageAccumulator => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  reasoningTokens: 0,
  total: 0,
  cost: undefined,
  assistantTurns: 0,
});

export const mergeUsageIntoAccumulator = (
  target: UsageAccumulator,
  usage: NormalizedUsage | undefined,
) => {
  if (!usage) {
    return;
  }
  const unavailable = usage.usageReport?.state === "unavailable";
  if (unavailable) {
    target.usageReport = usage.usageReport;
  }
  if (!unavailable && !hasBillableUsage(usage)) {
    return;
  }
  target.usageReport ??= usage.usageReport;
  const callTotal =
    usage.total ??
    (usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
  for (const key of ["cacheRead", "cacheWrite"] as const) {
    if (usage[key] !== undefined) {
      target[`${key}Reported`] = true;
    }
  }
  for (const key of USAGE_COST_COMPONENTS) {
    target[key] += usage[key] ?? 0;
  }
  for (const key of ["cacheWrite1h", "cacheWrite5m"] as const) {
    if (usage[key] !== undefined) {
      target[key] = (target[key] ?? 0) + usage[key];
    }
  }
  target.reasoningTokens += usage.reasoningTokens ?? 0;
  target.total += callTotal;
  const previous = target.cost;
  // Never-priced complete counters can use linear catalog pricing. Partial or
  // mixed recorded prices remain incomplete and must not be reconstructed.
  if (
    !unavailable &&
    usage.cost === undefined &&
    usage.costStatus === undefined &&
    target.costStatus === undefined &&
    (previous === undefined || previous === "unavailable") &&
    USAGE_COST_COMPONENTS.every((key) => usage[key] !== undefined)
  ) {
    target.cost = "unavailable";
    return;
  }
  const cost: NonNullable<NormalizedUsage["cost"]> = {};
  for (const key of [...USAGE_COST_COMPONENTS, "total"] as const) {
    const amount =
      !unavailable || usage.cost?.totalOrigin === "provider-billed" ? usage.cost?.[key] : undefined;
    if (
      !(key === "total" && usage.costStatus === "unavailable") &&
      amount !== undefined &&
      (previous === undefined || (previous !== "unavailable" && previous[key] !== undefined))
    ) {
      const sum = (previous?.[key] ?? 0) + amount;
      if (Number.isFinite(sum)) {
        cost[key] = sum;
      }
    }
  }
  if (
    cost.total !== undefined &&
    usage.cost?.totalOrigin === "provider-billed" &&
    (!previous || (previous !== "unavailable" && previous.totalOrigin === "provider-billed"))
  ) {
    cost.totalOrigin = "provider-billed";
  }
  target.costStatus = cost.total === undefined ? "unavailable" : "complete";
  target.cost = cost;
};

/** Retains bridge counts before attempt cleanup clears its tool-search catalog. */
export const mergeAttemptRunStatsIntoAccumulator = (
  target: UsageAccumulator,
  attempt: Pick<EmbeddedAgentMeta, "assistantTurns" | "bridgeCalls">,
) => {
  target.assistantTurns += attempt.assistantTurns ?? 0;
  if (!attempt.bridgeCalls) {
    return;
  }
  const bridgeCalls = target.bridgeCalls ?? { search: 0, describe: 0, call: 0 };
  bridgeCalls.search += attempt.bridgeCalls.search;
  bridgeCalls.describe += attempt.bridgeCalls.describe;
  bridgeCalls.call += attempt.bridgeCalls.call;
  target.bridgeCalls = bridgeCalls;
};

export const toNormalizedUsage = (usage: UsageAccumulator): NormalizedUsage | undefined => {
  if (usage.usageReport?.state === "unavailable") {
    return {
      usageReport: { state: "unavailable" },
      contextUsage: { state: "unavailable" },
      ...(usage.cost && usage.cost !== "unavailable" && usage.cost.total !== undefined
        ? { cost: { ...usage.cost }, costStatus: "complete" }
        : {}),
    };
  }
  const hasUsage =
    USAGE_COST_COMPONENTS.some((key) => usage[key] > 0) ||
    usage.reasoningTokens > 0 ||
    usage.total > 0;
  const cost =
    usage.cost === "unavailable" || !usage.cost || Object.keys(usage.cost).length === 0
      ? undefined
      : usage.cost;
  if (!usage.usageReport && !hasUsage && !cost) {
    return undefined;
  }
  const derivedTotal = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
  const completeUnpricedCounters = usage.cost === "unavailable" && usage.costStatus === undefined;
  return {
    ...(usage.usageReport ? { usageReport: usage.usageReport } : {}),
    input: usage.usageReport || completeUnpricedCounters ? usage.input : usage.input || undefined,
    output:
      usage.usageReport || completeUnpricedCounters ? usage.output : usage.output || undefined,
    cacheRead: usage.cacheReadReported ? usage.cacheRead : usage.cacheRead || undefined,
    cacheWrite: usage.cacheWriteReported ? usage.cacheWrite : usage.cacheWrite || undefined,
    ...(usage.cacheWrite1h !== undefined ? { cacheWrite1h: usage.cacheWrite1h } : {}),
    ...(usage.cacheWrite5m !== undefined ? { cacheWrite5m: usage.cacheWrite5m } : {}),
    ...(usage.reasoningTokens > 0 ? { reasoningTokens: usage.reasoningTokens } : {}),
    total: usage.usageReport ? usage.total : usage.total || derivedTotal || undefined,
    ...(cost ? { cost: { ...cost } } : {}),
    ...(usage.costStatus ? { costStatus: usage.costStatus } : {}),
  };
};
