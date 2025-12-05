// Lazy-load pi-ai model metadata so we can infer context windows when the agent
// reports a model id. pi-coding-agent depends on @mariozechner/pi-ai, so it
// should be present whenever CLAWDIS is installed from npm.

type ModelEntry = { id: string; contextWindow?: number };

const MODEL_CACHE = new Map<string, number>();
const loadPromise = (async () => {
  try {
    const piAi = (await import("@mariozechner/pi-ai")) as {
      getProviders: () => string[];
      getModels: (provider: string) => ModelEntry[];
    };
    const providers = piAi.getProviders();
    for (const p of providers) {
      const models = piAi.getModels(p) as ModelEntry[];
      for (const m of models) {
        if (!m?.id) continue;
        if (typeof m.contextWindow === "number" && m.contextWindow > 0) {
          MODEL_CACHE.set(m.id, m.contextWindow);
        }
      }
    }
  } catch {
    // If pi-ai isn't available, leave cache empty; lookup will fall back.
  }
})();

export function lookupContextTokens(modelId?: string): number | undefined {
  if (!modelId) return undefined;
  // Best-effort: kick off loading, but don't block.
  void loadPromise;
  return MODEL_CACHE.get(modelId);
}
