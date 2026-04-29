import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-types";

const CATALOG_DEFAULTS: Record<string, { contextWindow: number; cost: NonNullable<ModelProviderConfig["models"]>[number]["cost"] }> = {
  "deepseek-v4-flash": {
    contextWindow: 1_000_000,
    cost: { input: 0.14, output: 0.28, cacheRead: 0.028, cacheWrite: 0 },
  },
  "deepseek-v4-pro": {
    contextWindow: 1_000_000,
    cost: { input: 1.74, output: 3.48, cacheRead: 0.145, cacheWrite: 0 },
  },
  "deepseek-reasoner": {
    contextWindow: 200_000,
    cost: { input: 0.28, output: 0.42, cacheRead: 0.028, cacheWrite: 0 },
  },
  "deepseek-chat": {
    contextWindow: 131_072,
    cost: { input: 0.28, output: 0.42, cacheRead: 0.028, cacheWrite: 0 },
  },
};

export function normalizeConfig(params: {
  provider: string;
  providerConfig: ModelProviderConfig;
}): ModelProviderConfig {
  const pc = params.providerConfig;
  if (!pc?.models) return pc;
  let mutated = false;
  
  const models = pc.models.map((m) => {
    const defaults = CATALOG_DEFAULTS[m.id];
    if (!defaults) return m;
    let next = m;
    if (!m.cost) {
      mutated = true;
      next = { ...next, cost: defaults.cost };
    }
    if (!m.contextWindow) {
      mutated = true;
      next = {
        ...next,
        contextWindow: defaults.contextWindow,
        contextTokens: defaults.contextWindow,
      };
    }
    return next;
  });
  
  return mutated ? { ...pc, models } : pc;
}
