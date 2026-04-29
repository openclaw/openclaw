type ModelCost = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
};

type ModelEntry = {
  id: string;
  contextWindow?: number;
  contextTokens?: number;
  cost?: ModelCost;
};

type ProviderConfig = {
  models?: ModelEntry[];
};

const DEFAULTS: Record<string, { cw: number; cost: ModelCost }> = {
  "deepseek-v4-flash": {
    cw: 1_000_000,
    cost: { input: 0.14, output: 0.28, cacheRead: 0.028, cacheWrite: 0 },
  },
  "deepseek-v4-pro": {
    cw: 1_000_000,
    cost: { input: 1.74, output: 3.48, cacheRead: 0.145, cacheWrite: 0 },
  },
  "deepseek-reasoner": {
    cw: 200_000,
    cost: { input: 0.28, output: 0.42, cacheRead: 0.028, cacheWrite: 0 },
  },
  "deepseek-chat": {
    cw: 131_072,
    cost: { input: 0.28, output: 0.42, cacheRead: 0.028, cacheWrite: 0 },
  },
};

export function normalizeConfig(params: {
  provider: string;
  providerConfig: ProviderConfig;
}): ProviderConfig {
  const pc = params.providerConfig;
  if (!pc?.models) return pc;
  
  let changed = false;
  const models = pc.models.map((m) => {
    const d = DEFAULTS[m.id];
    if (!d) return m;
    if (!m.cost && !m.contextWindow) {
      changed = true;
      return {
        ...m,
        cost: d.cost,
        contextWindow: d.cw,
        contextTokens: d.cw,
      };
    }
    return m;
  });
  
  return changed ? { ...pc, models } : pc;
}
