import type { ClawdbrainConfig } from "../config/config.js";
import type { ModelRoutingPolicy, ModelRoutingTier } from "../config/types.model-routing.js";
import { DEFAULT_PROVIDER } from "./defaults.js";
import {
  buildModelAliasIndex,
  resolveModelRefFromString,
  type ModelRef,
} from "./model-selection.js";

export type ModelRoutingIntent = string;

export type ModelRoutingSelection = {
  intent: ModelRoutingIntent;
  mode: "off" | "tiered" | "hybrid";
  policy?: ModelRoutingPolicy;
  planner?: ModelRef;
  executor: ModelRef;
};

function mergePolicies(
  base?: ModelRoutingPolicy,
  override?: ModelRoutingPolicy,
): ModelRoutingPolicy {
  return { ...base, ...override };
}

function resolveRefFromConfig(params: {
  cfg: ClawdbrainConfig;
  raw?: string;
  fallback: ModelRef;
}): ModelRef {
  const trimmed = params.raw?.trim() ?? "";
  if (!trimmed) return params.fallback;

  const aliasIndex = buildModelAliasIndex({
    cfg: params.cfg,
    defaultProvider: DEFAULT_PROVIDER,
  });
  const resolved = resolveModelRefFromString({
    raw: trimmed,
    defaultProvider: DEFAULT_PROVIDER,
    aliasIndex,
  });
  return resolved?.ref ?? params.fallback;
}

function resolveTierModel(params: {
  cfg: ClawdbrainConfig;
  tier: ModelRoutingTier;
  base: ModelRef;
}): ModelRef {
  const routing = params.cfg.agents?.defaults?.modelRouting;
  const models = routing?.models;
  if (params.tier === "local-small") {
    return resolveRefFromConfig({
      cfg: params.cfg,
      raw: models?.localSmall,
      fallback: params.base,
    });
  }
  if (params.tier === "local-large") {
    return resolveRefFromConfig({
      cfg: params.cfg,
      raw: models?.localLarge,
      fallback: params.base,
    });
  }
  // remote
  return resolveRefFromConfig({ cfg: params.cfg, raw: models?.remote, fallback: params.base });
}

function defaultHybridTier(cfg: ClawdbrainConfig): ModelRoutingTier {
  const routing = cfg.agents?.defaults?.modelRouting;
  const models = routing?.models;
  if (models?.localLarge?.trim()) return "local-large";
  if (models?.localSmall?.trim()) return "local-small";
  return "remote";
}

function chooseTierFromSignals(params: {
  cfg: ClawdbrainConfig;
  policy: ModelRoutingPolicy;
}): ModelRoutingTier {
  const stakes = params.policy.stakes ?? "medium";
  const verifiability = params.policy.verifiability ?? "medium";
  const allowWriteTools = params.policy.allowWriteTools ?? true;

  if (stakes === "high") return "remote";
  if (verifiability === "low") return "remote";

  if (verifiability === "high" && stakes === "low" && !allowWriteTools) {
    // Prefer smaller local tiers for highly verifiable + low-stakes, read-only work.
    const routing = params.cfg.agents?.defaults?.modelRouting;
    if (routing?.models?.localSmall?.trim()) return "local-small";
  }

  // Default to the biggest available local tier (better tool discipline), else remote.
  return defaultHybridTier(params.cfg);
}

export function resolveModelRoutingSelection(params: {
  cfg: ClawdbrainConfig;
  intent: ModelRoutingIntent;
  base: ModelRef;
  sessionHasModelOverride?: boolean;
}): ModelRoutingSelection {
  const routing = params.cfg.agents?.defaults?.modelRouting;
  if (!routing?.enabled) {
    return { intent: params.intent, mode: "off", executor: params.base };
  }

  const policy = mergePolicies(routing.defaultPolicy, routing.intents?.[params.intent]);
  const mode = policy.mode ?? "tiered";

  const respectSessionOverride = policy.respectSessionOverride ?? true;
  if (respectSessionOverride && params.sessionHasModelOverride) {
    return { intent: params.intent, mode: "off", policy, executor: params.base };
  }

  if (mode === "off") {
    return { intent: params.intent, mode, policy, executor: params.base };
  }

  if (mode === "hybrid") {
    const planner = resolveRefFromConfig({
      cfg: params.cfg,
      raw: policy.plannerModel ?? routing.models?.planner ?? routing.models?.remote ?? undefined,
      fallback: params.base,
    });

    const executor = policy.executorModel?.trim()
      ? resolveRefFromConfig({ cfg: params.cfg, raw: policy.executorModel, fallback: params.base })
      : resolveTierModel({
          cfg: params.cfg,
          tier:
            policy.executorTier ??
            policy.tier ??
            chooseTierFromSignals({ cfg: params.cfg, policy }),
          base: params.base,
        });

    return { intent: params.intent, mode, policy, planner, executor };
  }

  // tiered
  const executor = policy.executorModel?.trim()
    ? resolveRefFromConfig({ cfg: params.cfg, raw: policy.executorModel, fallback: params.base })
    : resolveTierModel({
        cfg: params.cfg,
        tier: policy.tier ?? chooseTierFromSignals({ cfg: params.cfg, policy }),
        base: params.base,
      });

  return { intent: params.intent, mode, policy, executor };
}
