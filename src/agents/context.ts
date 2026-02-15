// Lazy-load pi-coding-agent model metadata so we can infer context windows when
// the agent reports a model id. This includes custom models.json entries.

import { loadConfig } from "../config/config.js";
import { resolveOpenClawAgentDir } from "./agent-paths.js";
import { ensureOpenClawModelsJson } from "./models-config.js";

type ModelEntry = { id: string; contextWindow?: number };
type ConfigModelEntry = { id?: string; contextWindow?: number };
type ProviderConfigEntry = { models?: ConfigModelEntry[] };
type ModelsConfig = { providers?: Record<string, ProviderConfigEntry | undefined> };

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
    const modelRegistry = discoverModels(authStorage, agentDir);
    const models = modelRegistry.getAll() as ModelEntry[];
    for (const m of models) {
      if (!m?.id) {
        continue;
      }
      if (typeof m.contextWindow === "number" && m.contextWindow > 0) {
        MODEL_CACHE.set(m.id, m.contextWindow);
      }
    }
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

export function lookupContextTokens(modelId?: string): number | undefined {
  if (!modelId) {
    return undefined;
  }
  // Best-effort: kick off loading, but don't block.
  void loadPromise;
  return MODEL_CACHE.get(modelId);
}
