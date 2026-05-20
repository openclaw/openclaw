import {
  resolveBrainProfileForMode,
  type NormalizedBrainTierConfig,
  type ResolvedBrainProfile,
} from "./brain-profiles.js";
import type { ModelTierMode } from "./model-tiers.js";

type ConfigObject = Record<string, unknown>;

function cloneConfig(config: Record<string, unknown>): ConfigObject {
  return JSON.parse(JSON.stringify(config ?? {})) as ConfigObject;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function ensureAgentDefaults(config: ConfigObject): ConfigObject {
  const agents = asRecord(config.agents);
  const defaults = asRecord(agents.defaults);
  defaults.models = asRecord(defaults.models);
  agents.defaults = defaults;
  agents.list = Array.isArray(agents.list) ? agents.list : [];
  config.agents = agents;
  return config;
}

function modelValueForResolved(current: unknown, resolved: ResolvedBrainProfile): unknown {
  const modelObject =
    resolved.fallbacks.length > 0
      ? { primary: resolved.modelRef, fallbacks: resolved.fallbacks }
      : { primary: resolved.modelRef };
  if (current && typeof current === "object" && !Array.isArray(current)) {
    return { ...(current as Record<string, unknown>), ...modelObject };
  }
  return resolved.fallbacks.length > 0 ? modelObject : resolved.modelRef;
}

function ensureModelParams(config: ConfigObject, resolved: ResolvedBrainProfile): void {
  const agents = asRecord(config.agents);
  const defaults = asRecord(agents.defaults);
  const models = asRecord(defaults.models) as Record<string, Record<string, unknown>>;
  const existing = models[resolved.modelRef] ?? {};
  models[resolved.modelRef] = {
    ...existing,
    params: {
      ...(existing.params as Record<string, unknown> | undefined),
      ...resolved.params,
    },
  };
}

export function applyGlobalBrainTierPatch(
  config: Record<string, unknown>,
  mode: ModelTierMode,
  tierConfig: NormalizedBrainTierConfig,
): ConfigObject {
  const next = ensureAgentDefaults(cloneConfig(config));
  const globalResolved = resolveBrainProfileForMode(tierConfig, mode);
  const agents = asRecord(next.agents);
  const defaults = asRecord(agents.defaults);
  defaults.model = modelValueForResolved(undefined, globalResolved);
  ensureModelParams(next, globalResolved);

  agents.list = (agents.list as Array<Record<string, unknown>>).map((entry) => {
    const agentId = typeof entry.id === "string" ? entry.id : "";
    if (!agentId) {
      return entry;
    }
    const effectiveMode = tierConfig.agentOverrides[agentId] ?? mode;
    const resolved = resolveBrainProfileForMode(tierConfig, effectiveMode);
    ensureModelParams(next, resolved);
    return { ...entry, model: modelValueForResolved(entry.model, resolved) };
  });

  return next;
}

export function applyAgentBrainTierPatch(
  config: Record<string, unknown>,
  agentId: string,
  mode: ModelTierMode | "inherit",
  tierConfig: NormalizedBrainTierConfig,
): ConfigObject {
  const next = ensureAgentDefaults(cloneConfig(config));
  const agents = asRecord(next.agents);
  const list = agents.list as Array<Record<string, unknown>>;
  const agentIndex = list.findIndex(
    (entry) => typeof entry.id === "string" && entry.id.toLowerCase() === agentId.toLowerCase(),
  );

  if (mode === "inherit") {
    if (agentIndex >= 0) {
      delete list[agentIndex].model;
    }
    return next;
  }

  const resolved = resolveBrainProfileForMode(tierConfig, mode);
  ensureModelParams(next, resolved);

  if (agentIndex >= 0) {
    list[agentIndex] = {
      ...list[agentIndex],
      model: modelValueForResolved(list[agentIndex].model, resolved),
    };
  } else {
    list.push({ id: agentId, model: modelValueForResolved(undefined, resolved) });
  }

  return next;
}
