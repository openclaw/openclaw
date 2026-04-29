import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-types";

type ModelCost = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
};

interface DefaultEntry {
  contextWindow: number;
  cost: ModelCost;
}

const DEFAULTS: Record<string, DefaultEntry> = {
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
  if (!pc?.models) {
    return pc;
  }

  let changed = false;
  const models = pc.models.map((m) => {
    const d = DEFAULTS[m.id];
    if (!d) {
      return m;
    }
    if (m.contextWindow) {
      return m;
    }
    changed = true;
    if (!m.cost) {
      return {
        ...m,
        contextWindow: d.contextWindow,
        contextTokens: d.contextWindow,
        cost: d.cost,
      };
    }
    return {
      ...m,
      contextWindow: d.contextWindow,
      contextTokens: d.contextWindow,
    };
  });

  return changed ? { ...pc, models } : pc;
}
