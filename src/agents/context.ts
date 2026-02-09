// Lazy-load pi-coding-agent model metadata so we can infer context windows when
// the agent reports a model id. This includes custom models.json entries.

import { loadConfig } from "../config/config.js";
import { resolveOpenClawAgentDir } from "./agent-paths.js";
import { ensureOpenClawModelsJson } from "./models-config.js";

type ModelEntry = { id: string; contextWindow?: number };

const MODEL_CACHE = new Map<string, number>();
const loadPromise = (async () => {
  try {
    const { discoverAuthStorage, discoverModels } = await import("./pi-model-discovery.js");
    const cfg = loadConfig();
    await ensureOpenClawModelsJson(cfg);
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
    // If pi-ai isn't available, leave cache empty; lookup will fall back.
  }
})();

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
