import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { estimateAggregateUsageCost } from "../../utils/usage-format.js";
import type { NormalizedUsage } from "../usage.js";
import type { EmbeddedAgentMeta } from "./types.js";
import {
  mergeAttemptRunStatsIntoAccumulator,
  mergeUsageIntoAccumulator,
  toNormalizedUsage,
  type UsageAccumulator,
} from "./usage-accumulator.js";

/** Resolve prices before combining work that may belong to different models. */
export function mergeCompletedAgentUsage(params: {
  usage: UsageAccumulator;
  diagnosticUsage: UsageAccumulator;
  agentMeta?: EmbeddedAgentMeta;
  config: OpenClawConfig;
  agentDir?: string;
}) {
  const candidate = params.agentMeta;
  const priceUsage = (usage: NormalizedUsage | undefined): NormalizedUsage => {
    const costUsd = estimateAggregateUsageCost({
      usage,
      provider: candidate?.provider,
      model: candidate?.model,
      config: params.config,
      agentDir: params.agentDir,
    });
    return {
      ...usage,
      cost: costUsd === undefined ? undefined : { ...usage?.cost, total: costUsd },
      costStatus: costUsd === undefined ? "unavailable" : "complete",
    };
  };
  const usage = priceUsage(candidate?.usage);
  mergeUsageIntoAccumulator(params.usage, usage);
  mergeUsageIntoAccumulator(
    params.diagnosticUsage,
    candidate?.diagnosticUsage && candidate.diagnosticUsage !== candidate.usage
      ? priceUsage(candidate.diagnosticUsage)
      : usage,
  );
  mergeAttemptRunStatsIntoAccumulator(params.usage, candidate ?? {});
}

/** Billing totals span requests; only the selected result owns live context. */
export function buildCompletedAgentUsageMeta(
  usage: UsageAccumulator,
  diagnosticUsage: UsageAccumulator,
): Pick<
  EmbeddedAgentMeta,
  "usage" | "diagnosticUsage" | "costUsd" | "assistantTurns" | "bridgeCalls"
> {
  const aggregate = toNormalizedUsage(usage);
  return {
    usage: aggregate ? { ...aggregate, contextUsage: { state: "unavailable" } } : undefined,
    diagnosticUsage: toNormalizedUsage(diagnosticUsage),
    costUsd: usage.cost && usage.cost !== "unavailable" ? usage.cost.total : undefined,
    assistantTurns: usage.assistantTurns,
    ...(usage.bridgeCalls ? { bridgeCalls: usage.bridgeCalls } : {}),
  };
}
