// Lazy-load pi-coding-agent model metadata so we can infer context windows when
// the agent reports a model id. This includes custom models.json entries.

import { loadConfig } from "../config/config.js";
import { resolveBotAgentDir } from "./agent-paths.js";
import { ensureBotModelsJson } from "./models-config.js";

type ModelEntry = { id: string; contextWindow?: number };
type ModelRegistryLike = {
  getAvailable?: () => ModelEntry[];
  getAll: () => ModelEntry[];
};
type ConfigModelEntry = { id?: string; contextWindow?: number };
type ProviderConfigEntry = { models?: ConfigModelEntry[] };
type ModelsConfig = { providers?: Record<string, ProviderConfigEntry | undefined> };

export function applyDiscoveredContextWindows(params: {
  cache: Map<string, number>;
  models: ModelEntry[];
}) {
  for (const model of params.models) {
    if (!model?.id) {
      continue;
    }
    const contextWindow =
      typeof model.contextWindow === "number" ? Math.trunc(model.contextWindow) : undefined;
    if (!contextWindow || contextWindow <= 0) {
      continue;
    }
    const existing = params.cache.get(model.id);
    // When multiple providers expose the same model id with different limits,
    // prefer the smaller window so token budgeting is fail-safe (no overestimation).
    if (existing === undefined || contextWindow < existing) {
      params.cache.set(model.id, contextWindow);
    }
  }
}

export function applyConfiguredContextWindows(params: {
  cache: Map<string, number>;
  modelsConfig: ModelsConfig | undefined;
}) {
  const providers = params.modelsConfig?.providers;
  if (!providers || typeof providers !== "object") {
    return;
  }
  for (const provider of Object.values(providers)) {
    if (!Array.isArray(provider?.models)) {
      continue;
    }
    for (const model of provider.models) {
      const modelId = typeof model?.id === "string" ? model.id : undefined;
      const contextWindow =
        typeof model?.contextWindow === "number" ? model.contextWindow : undefined;
      if (!modelId || !contextWindow || contextWindow <= 0) {
        continue;
      }
      params.cache.set(modelId, contextWindow);
    }
  }
}

const MODEL_CACHE = new Map<string, number>();
const loadPromise = (async () => {
  let cfg: ReturnType<typeof loadConfig> | undefined;
  try {
    cfg = loadConfig();
  } catch {
    // If config can't be loaded, leave cache empty.
    return;
  }

  try {
    await ensureBotModelsJson(cfg);
  } catch {
    // Continue with best-effort discovery/overrides.
  }

  try {
    const { discoverAuthStorage, discoverModels } = await import("./pi-model-discovery.js");
    const agentDir = resolveBotAgentDir();
    const authStorage = discoverAuthStorage(agentDir);
    const modelRegistry = discoverModels(authStorage, agentDir) as unknown as ModelRegistryLike;
    const models =
      typeof modelRegistry.getAvailable === "function"
        ? modelRegistry.getAvailable()
        : modelRegistry.getAll();
    applyDiscoveredContextWindows({
      cache: MODEL_CACHE,
      models,
    });
  } catch {
    // If model discovery fails, continue with config overrides only.
  }

  applyConfiguredContextWindows({
    cache: MODEL_CACHE,
    modelsConfig: cfg.models as ModelsConfig | undefined,
  });
})().catch(() => {
  // Keep lookup best-effort.
});

// Anthropic 1M extended context window (opus/sonnet models only).
export const ANTHROPIC_CONTEXT_1M_TOKENS = 1_000_000;

// Anthropic model id prefixes eligible for the context1m param.
const ANTHROPIC_CONTEXT_1M_ELIGIBLE_PREFIXES = [
  "claude-opus-",
  "claude-opus-4",
  "claude-sonnet-",
  "claude-sonnet-4",
];

function isAnthropicContext1mEligible(modelId: string): boolean {
  const lower = modelId.toLowerCase();
  return ANTHROPIC_CONTEXT_1M_ELIGIBLE_PREFIXES.some(
    (prefix) => lower === prefix || lower.startsWith(prefix),
  );
}

type BotConfigLike = {
  agents?: {
    defaults?: {
      models?: Record<string, { params?: { context1m?: boolean } } | undefined>;
    };
  };
};

/**
 * Resolve effective context tokens for a given model, accounting for the
 * Anthropic `context1m` param, an explicit override, and a fallback default.
 */
export function resolveContextTokensForModel(params: {
  cfg?: BotConfigLike;
  provider: string;
  model: string | null;
  contextTokensOverride?: number;
  fallbackContextTokens?: number;
}): number | undefined {
  // Explicit per-session/per-model override takes first priority.
  if (typeof params.contextTokensOverride === "number" && params.contextTokensOverride > 0) {
    return params.contextTokensOverride;
  }

  // Check for Anthropic context1m param.
  if (params.provider === "anthropic" && params.model) {
    const modelKey = `${params.provider}/${params.model}`;
    const modelEntry = params.cfg?.agents?.defaults?.models?.[modelKey];
    if (modelEntry?.params?.context1m && isAnthropicContext1mEligible(params.model)) {
      return ANTHROPIC_CONTEXT_1M_TOKENS;
    }
  }

  return params.fallbackContextTokens;
}

export function lookupContextTokens(modelId?: string): number | undefined {
  if (!modelId) {
    return undefined;
  }
  // Best-effort: kick off loading, but don't block.
  void loadPromise;
  return MODEL_CACHE.get(modelId);
}
