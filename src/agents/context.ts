// Lazy-load pi-coding-agent model metadata so we can infer context windows when
// the agent reports a model id. This includes custom models.json entries.

import { loadConfig } from "../config/config.js";
import { resolveOpenClawAgentDir } from "./agent-paths.js";
import { ensureOpenClawModelsJson } from "./models-config.js";

type ModelEntry = { id: string; contextWindow?: number };

// Override incorrect context windows from upstream packages.
// Sonnet 4.5 context window is 1M, not 2M (requires beta headers for API access).
// See: https://platform.claude.com/docs/en/build-with-claude/context-windows
const CONTEXT_WINDOW_OVERRIDES: Record<string, number> = {
  "claude-sonnet-4-5": 1_000_000,
  "claude-sonnet-4-5-20250514": 1_000_000,
};

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
      // Apply local overrides for known incorrect values from upstream
      const override = CONTEXT_WINDOW_OVERRIDES[m.id];
      if (override !== undefined) {
        MODEL_CACHE.set(m.id, override);
      } else if (typeof m.contextWindow === "number" && m.contextWindow > 0) {
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
  return MODEL_CACHE.get(modelId);
}
