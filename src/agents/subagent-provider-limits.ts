import type { OpenClawConfig } from "../config/config.js";
import {
  normalizeSubagentProviderLimitKey,
  resolveSubagentProviderLimits,
} from "../config/agent-limits.js";
import { resolveAgentConfig } from "./agent-scope.js";
import { getProviderUsage, listAllSubagentRuns } from "./subagent-registry.js";

export type ProviderUsageSummaryRow = {
  provider: string;
  active: number;
  pending: number;
  total: number;
  max: number;
  available: number;
};

function normalizeModelSelection(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed || undefined;
  }
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const primary = (value as { primary?: unknown }).primary;
  if (typeof primary === "string" && primary.trim()) {
    return primary.trim();
  }
  return undefined;
}

function resolveProviderFromModel(modelRef?: string): string | undefined {
  if (!modelRef) {
    return undefined;
  }
  const trimmed = modelRef.trim();
  if (!trimmed) {
    return undefined;
  }
  const slashIndex = trimmed.indexOf("/");
  if (slashIndex <= 0 || slashIndex === trimmed.length - 1) {
    return undefined;
  }
  return trimmed.slice(0, slashIndex).trim() || undefined;
}

export function normalizeProviderForLimit(provider?: string): string | undefined {
  return normalizeSubagentProviderLimitKey(provider);
}

export function resolveSpawnProvider(params: {
  cfg: OpenClawConfig;
  targetAgentId: string;
  modelOverride?: string;
}): { provider?: string; model?: string } {
  const targetAgentConfig = resolveAgentConfig(params.cfg, params.targetAgentId);
  const model =
    normalizeModelSelection(params.modelOverride) ??
    normalizeModelSelection(targetAgentConfig?.subagents?.model) ??
    normalizeModelSelection(params.cfg.agents?.defaults?.subagents?.model) ??
    normalizeModelSelection(targetAgentConfig?.model) ??
    normalizeModelSelection(params.cfg.agents?.defaults?.model);

  const provider = normalizeProviderForLimit(resolveProviderFromModel(model));
  return { provider, model };
}

export function buildProviderUsageSummary(cfg?: OpenClawConfig): ProviderUsageSummaryRow[] {
  const limits = resolveSubagentProviderLimits(cfg);
  const providers = new Set(Object.keys(limits));

  for (const run of listAllSubagentRuns()) {
    const normalized = normalizeProviderForLimit(run.provider);
    if (!normalized) {
      continue;
    }
    if (Object.hasOwn(limits, normalized)) {
      providers.add(normalized);
      continue;
    }
    providers.add("unknown");
  }

  return [...providers]
    .toSorted((left, right) => left.localeCompare(right))
    .flatMap((provider) => {
      const max = limits[provider];
      if (typeof max !== "number" || !Number.isFinite(max) || max < 1) {
        return [];
      }
      const usage = getProviderUsage(provider);
      return [
        {
          provider,
          active: usage.active,
          pending: usage.pending,
          total: usage.total,
          max,
          available: Math.max(0, max - usage.total),
        },
      ];
    });
}
