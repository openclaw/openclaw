import { hasBillableUsage, hasRecordedUsageCost, USAGE_COST_COMPONENTS } from "../usage.js";
import type { NormalizedUsage } from "../usage.js";
import type { EmbeddedAgentMeta } from "./types.js";

export type UsageAccumulator = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cacheReadReported?: true;
  cacheWriteReported?: true;
  cacheWrite1h: number;
  reasoningTokens: number;
  total: number;
  /** Undefined means unobserved; any missing call price makes the complete sum unavailable. */
  cost: NormalizedUsage["cost"] | "unavailable";
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
  cacheWrite1h: 0,
  reasoningTokens: 0,
  total: 0,
  cost: undefined,
  assistantTurns: 0,
});

export const mergeUsageIntoAccumulator = (
  target: UsageAccumulator,
  usage: NormalizedUsage | undefined,
) => {
  if (!hasBillableUsage(usage)) {
    return;
  }
  const callTotal =
    usage.total ??
    (usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
  if (usage.cacheRead !== undefined) {
    target.cacheReadReported = true;
  }
  if (usage.cacheWrite !== undefined) {
    target.cacheWriteReported = true;
  }
  target.input += usage.input ?? 0;
  target.output += usage.output ?? 0;
  target.cacheRead += usage.cacheRead ?? 0;
  target.cacheWrite += usage.cacheWrite ?? 0;
  target.cacheWrite1h += usage.cacheWrite1h ?? 0;
  target.reasoningTokens += usage.reasoningTokens ?? 0;
  target.total += callTotal;
  if (target.cost === "unavailable" || !usage.cost) {
    target.cost = "unavailable";
    return;
  }
  const cost: NonNullable<NormalizedUsage["cost"]> = {
    total: (target.cost?.total ?? 0) + usage.cost.total,
  };
  if (
    usage.cost.totalOrigin === "provider-billed" &&
    (!target.cost || target.cost.totalOrigin === "provider-billed")
  ) {
    cost.totalOrigin = "provider-billed";
  }
  if (
    cost.total === 0 &&
    hasRecordedUsageCost(usage.cost) &&
    (!target.cost || hasRecordedUsageCost(target.cost))
  ) {
    for (const key of USAGE_COST_COMPONENTS) {
      const component = (target.cost?.[key] ?? 0) + (usage.cost[key] ?? 0);
      if (component !== 0) {
        cost[key] = component;
      }
    }
  }
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
  const hasUsage =
    usage.input > 0 ||
    usage.output > 0 ||
    usage.cacheRead > 0 ||
    usage.cacheWrite > 0 ||
    usage.reasoningTokens > 0 ||
    usage.total > 0;
  const cost = usage.cost === "unavailable" ? undefined : usage.cost;
  if (!hasUsage && !cost) {
    return undefined;
  }
  const derivedTotal = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
  return {
    input: usage.input || undefined,
    output: usage.output || undefined,
    cacheRead: usage.cacheReadReported ? usage.cacheRead : usage.cacheRead || undefined,
    cacheWrite: usage.cacheWriteReported ? usage.cacheWrite : usage.cacheWrite || undefined,
    ...(usage.cacheWrite1h > 0 ? { cacheWrite1h: usage.cacheWrite1h } : {}),
    ...(usage.reasoningTokens > 0 ? { reasoningTokens: usage.reasoningTokens } : {}),
    total: usage.total || derivedTotal || undefined,
    ...(cost ? { cost: { ...cost } } : {}),
  };
};
