// Lazy-load pi-coding-agent model metadata so we can infer context windows when
// the agent reports a model id. This includes custom models.json entries.

import { loadConfig } from "../config/config.js";
import { resolveOpenClawAgentDir } from "./agent-paths.js";
import { ensureOpenClawModelsJson } from "./models-config.js";

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
    await ensureOpenClawModelsJson(cfg);
  } catch {
    // Continue with best-effort discovery/overrides.
  }

  try {
    const { discoverAuthStorage, discoverModels } = await import("./pi-model-discovery.js");
    const agentDir = resolveOpenClawAgentDir();
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

/**
 * Synchronous fallback cache populated once from the user's config file.
 * Covers the cold-start window before the async model-discovery cache has
 * been populated.  Hydrated lazily on first fallback lookup, then reused
 * for subsequent calls to avoid repeated config reloads.
 */
let configCachePopulated = false;
const CONFIG_CACHE = new Map<string, number>();

function ensureConfigCache(): void {
  if (configCachePopulated) {
    return;
  }
  try {
    const cfg = loadConfig();
    const providers = cfg?.models?.providers;
    if (!providers) {
      configCachePopulated = true;
      return;
    }
    for (const provider of Object.values(providers)) {
      const models = Array.isArray(provider?.models) ? provider.models : [];
      for (const m of models) {
        if (m?.id && typeof m.contextWindow === "number" && m.contextWindow > 0) {
          CONFIG_CACHE.set(m.id, m.contextWindow);
        }
      }
    }
    configCachePopulated = true;
  } catch {
    // Config unavailable — leave cache empty.  Do NOT set
    // configCachePopulated so the next call retries after a
    // transient failure instead of permanently returning undefined.
  }
}

export function lookupContextTokens(modelId?: string): number | undefined {
  if (!modelId) {
    return undefined;
  }
  // Best-effort: kick off async discovery loading, but don't block.
  void loadPromise;
  const cached = MODEL_CACHE.get(modelId);
  if (cached !== undefined) {
    return cached;
  }
  ensureConfigCache();
  return CONFIG_CACHE.get(modelId);
}
