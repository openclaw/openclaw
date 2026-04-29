export function normalizeConfig(params: {
  provider: string;
  providerConfig: any;
}): any {
  const pc = params.providerConfig;
  if (!pc?.models) {
    return pc;
  }
  
  const DEFAULTS: Record<string, any> = {
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
  
  let changed = false;
  const models = pc.models.map((m: any) => {
    const d = DEFAULTS[m.id];
    if (!d) {
      return m;
    }
    if (!m.contextWindow) {
      changed = true;
      return {
        ...m,
        contextWindow: d.contextWindow,
        contextTokens: d.contextWindow,
        ...(m.cost ? {} : { cost: d.cost }),
      };
    }
    return m;
  });
  
  return changed ? { ...pc, models } : pc;
}
