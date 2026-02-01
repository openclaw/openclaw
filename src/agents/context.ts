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

export function lookupContextTokens(modelId?: string): number | undefined {
  if (!modelId) {
    return undefined;
  }
  // Best-effort: kick off loading, but don't block.
  void loadPromise;

  // Try exact match first (only if it contains a slash, i.e., already has provider prefix)
  if (modelId.includes("/")) {
    const exact = MODEL_CACHE.get(modelId);
    if (exact !== undefined) {
      return exact;
    }
  }

  // For bare model names (no slash), try common provider prefixes first
  // to prefer our custom config over built-in defaults.
  // Priority order: prefer anthropic, then openai, then google
  const prefixes = ["anthropic", "openai", "google"];
  for (const prefix of prefixes) {
    const prefixedKey = `${prefix}/${modelId}`;
    const prefixed = MODEL_CACHE.get(prefixedKey);
    if (prefixed !== undefined) {
      return prefixed;
    }
  }

  // Fallback to exact match for bare model names (built-in defaults)
  const exact = MODEL_CACHE.get(modelId);
  if (exact !== undefined) {
    return exact;
  }

  // Final fallback: any matching suffix
  for (const [key, value] of MODEL_CACHE) {
    if (key.endsWith(`/${modelId}`)) {
      return value;
    }
  }

  return undefined;
}
