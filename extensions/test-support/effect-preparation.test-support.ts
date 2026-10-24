type FetchRuntime = typeof import("openclaw/plugin-sdk/fetch-runtime");
type ImportOriginal = <T>() => Promise<T>;
type EffectPreparation = () => Promise<void>;

export function createEffectPreparationGate() {
  const gate = {
    prepare: undefined as EffectPreparation | undefined,
    mockRuntime: async (importOriginal: ImportOriginal): Promise<FetchRuntime> => {
      const actual = await importOriginal<FetchRuntime>();
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
    },
  };
  return gate;
}
