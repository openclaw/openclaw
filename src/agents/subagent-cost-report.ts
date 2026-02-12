import type { SubagentUsageMetrics } from "./subagent-registry.js";
import { loadConfig } from "../config/config.js";
import {
  canonicalizeRequesterStoreKey,
  loadSessionStore,
  resolveStorePath,
  updateSessionStore,
  type SessionEntry,
} from "../config/sessions.js";
import { resolveAgentIdFromSessionKey } from "../routing/session-key.js";
import { estimateUsageCost, resolveModelCostConfig } from "../utils/usage-format.js";

/**
 * Collect usage metrics (tokens + cost) from a child session entry.
 * Returns undefined if the session has no meaningful token data.
 */
export function collectSubagentUsage(params: {
  childSessionKey: string;
}): SubagentUsageMetrics | undefined {
  const cfg = loadConfig();
  const canonicalKey = canonicalizeRequesterStoreKey(cfg, params.childSessionKey);
  const agentId = resolveAgentIdFromSessionKey(canonicalKey);
  const storePath = resolveStorePath(cfg.session?.store, { agentId });
  const store = loadSessionStore(storePath);
  const entry = store[canonicalKey];
  if (!entry) {
    return undefined;
  }

  const input = entry.inputTokens;
  const output = entry.outputTokens;
  const total =
    entry.totalTokens ??
    (typeof input === "number" && typeof output === "number" ? input + output : undefined);

  if (total === undefined && input === undefined && output === undefined) {
    return undefined;
  }

  const provider = entry.modelProvider ?? entry.providerOverride;
  const model = entry.model ?? entry.modelOverride;

  const costConfig = resolveModelCostConfig({ provider, model, config: cfg });
  const cost = estimateUsageCost({
    usage: { input: input ?? undefined, output: output ?? undefined },
    cost: costConfig,
  });

  return {
    inputTokens: input,
    outputTokens: output,
    totalTokens: total,
    cost,
    model,
    provider,
  };
}

/**
 * Accumulate subagent usage metrics onto the parent (requester) session.
 * This is called after a subagent completes so that the parent session
 * tracks aggregated cost/token data from all of its child runs.
 */
export async function reportSubagentCostToParent(params: {
  requesterSessionKey: string;
  usage: SubagentUsageMetrics;
}): Promise<void> {
  const { requesterSessionKey, usage } = params;
  if (!requesterSessionKey) {
    return;
  }

  const cfg = loadConfig();
  const canonicalKey = canonicalizeRequesterStoreKey(cfg, requesterSessionKey);
  const agentId = resolveAgentIdFromSessionKey(canonicalKey);
  const storePath = resolveStorePath(cfg.session?.store, { agentId });

  await updateSessionStore(storePath, (store) => {
    const entry = store[canonicalKey];
    if (!entry) {
      return;
    }

    const patch: Partial<SessionEntry> = {};
    const addNum = (a?: number, b?: number): number | undefined => {
      if (a === undefined && b === undefined) {
        return undefined;
      }
      return (a ?? 0) + (b ?? 0);
    };

    patch.subagentInputTokens = addNum(entry.subagentInputTokens, usage.inputTokens);
    patch.subagentOutputTokens = addNum(entry.subagentOutputTokens, usage.outputTokens);
    patch.subagentTotalTokens = addNum(entry.subagentTotalTokens, usage.totalTokens);
    patch.subagentCost = addNum(entry.subagentCost, usage.cost);
    patch.subagentRunCount = (entry.subagentRunCount ?? 0) + 1;

    Object.assign(entry, patch);
    store[canonicalKey] = entry;
  });
}
