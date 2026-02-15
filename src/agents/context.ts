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
 * Synchronous fallback: read contextWindow from the user's config file.
 * This is available immediately (no async discovery) so the first call
 * before MODEL_CACHE is populated still returns the correct value.
 */
function lookupContextTokensFromConfig(modelId: string): number | undefined {
  try {
    const cfg = loadConfig();
    const providers = cfg?.models?.providers;
    if (!providers || typeof providers !== "object") {
      return undefined;
    }
    for (const provider of Object.values(providers)) {
      const models = Array.isArray((provider as { models?: unknown }).models)
        ? ((provider as { models: unknown[] }).models as ModelEntry[])
        : [];
      for (const m of models) {
        if (m?.id === modelId && typeof m.contextWindow === "number" && m.contextWindow > 0) {
          return m.contextWindow;
        }
      }
    }
  } catch {
    // Config not available — fall through.
  }
  return undefined;
}

export function lookupContextTokens(modelId?: string): number | undefined {
  if (!modelId) {
    return undefined;
  }
  // Best-effort: kick off loading, but don't block.
  void loadPromise;
  return MODEL_CACHE.get(modelId) ?? lookupContextTokensFromConfig(modelId);
}
