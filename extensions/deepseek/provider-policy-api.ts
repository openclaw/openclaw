export function normalizeConfig(params: { provider: string; providerConfig: any }): any {
  const pc = params.providerConfig;
  if (!pc?.models) return pc;
  const COST_MAP: Record<string, any> = {
    "deepseek-v4-flash": { input: 1, output: 2, cacheRead: 0.02, cacheWrite: 0 },
    "deepseek-v4-pro":   { input: 3, output: 6, cacheRead: 0.025, cacheWrite: 0 },
    "deepseek-reasoner": { input: 2, output: 3, cacheRead: 0.2, cacheWrite: 0 },
  };
  const CW_MAP: Record<string, number> = {
    "deepseek-v4-flash": 1_000_000,
    "deepseek-v4-pro":   1_000_000,
    "deepseek-reasoner": 200_000,
  };
  let mutated = false;
  const models = pc.models.map((m: any) => {
    let next = m;
    const cost = COST_MAP[m.id];
    const cw = CW_MAP[m.id];
    if (cost && (!m.cost || m.cost.input !== cost.input)) {
      mutated = true;
      next = { ...next, cost };
    }
    if (cw && m.contextWindow !== cw) {
      mutated = true;
      next = { ...next, contextWindow: cw, contextTokens: cw };
    }
    return next;
  });
  return mutated ? { ...pc, models } : pc;
