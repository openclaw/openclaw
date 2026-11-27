type FetchRuntime = typeof import("openclaw/plugin-sdk/fetch-runtime");
type PreparationGate = { prepare: (() => Promise<void>) | undefined };

export function withEffectPreparation(actual: FetchRuntime, gate: PreparationGate) {
  return {
    ...actual,
    captureEffectAuthority: () => {
      const authority = actual.captureEffectAuthority();
      const prepare = gate.prepare;
      return prepare
        ? {
            ...authority,
            initiate: async <T>(effect: () => T | Promise<T>) => {
              await prepare();
              return authority.initiate(effect);
            },
          }
        : authority;
    },
  };
}
