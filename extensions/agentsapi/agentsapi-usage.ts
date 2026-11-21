import { makeZeroUsageSnapshot } from "openclaw/plugin-sdk/agent-harness-attempt-runtime";
import {
  normalizeUsage,
  type AgentHarnessAttemptParamsV2,
  type NormalizedUsage,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { calculateCost, type AssistantMessage } from "openclaw/plugin-sdk/llm";

export function aggregateAgentsApiUsage(
  model: AgentHarnessAttemptParamsV2["model"],
  contributions: Iterable<NormalizedUsage>,
): { usage: NormalizedUsage; assistantUsage: AssistantMessage["usage"] } {
  const usage = makeAgentsApiZeroUsage();
  let observed = false;
  let reasoningTokens: number | undefined;
  for (const normalized of contributions) {
    observed = true;
    usage.input += normalized.input ?? 0;
    usage.output += normalized.output ?? 0;
    usage.cacheRead += normalized.cacheRead ?? 0;
    usage.cacheWrite += normalized.cacheWrite ?? 0;
    usage.totalTokens +=
      normalized.total ??
      (normalized.input ?? 0) +
        (normalized.output ?? 0) +
        (normalized.cacheRead ?? 0) +
        (normalized.cacheWrite ?? 0);
    if (normalized.reasoningTokens !== undefined) {
      reasoningTokens = (reasoningTokens ?? 0) + normalized.reasoningTokens;
    }
  }
  if (observed) {
    calculateCost(model, usage);
    return {
      usage: {
        ...normalizeUsage(usage),
        ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
      },
      assistantUsage: usage,
    };
  }
  return {
    usage: { contextUsage: { state: "unavailable" } },
    assistantUsage: usage,
  };
}

export function makeAgentsApiZeroUsage(): AssistantMessage["usage"] {
  return {
    ...makeZeroUsageSnapshot(),
    // Turn billing sums hosted model calls; it is not a latest-call context snapshot.
    contextUsage: { state: "unavailable" },
  };
}
