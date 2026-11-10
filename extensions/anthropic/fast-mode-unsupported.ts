/** The plugin-state operations this owner needs; the plugin passes its keyed store. */
export type FastModeUnsupportedStore = {
  entries(): Promise<readonly { key: string }[]>;
  register(key: string, value: { learnedAt: number }): Promise<unknown>;
};

/**
 * Models Anthropic told us lack native fast mode. New Claude models are offered fast mode
 * by default; the first rejection falls back to standard speed and lands here, so the
 * model stops being offered fast mode in this process and, through plugin state, after
 * a restart.
 */
export function createFastModeUnsupportedModels(params: {
  openStore: () => FastModeUnsupportedStore;
  warn: (message: string) => void;
}) {
  const known = new Set<string>();
  let store: FastModeUnsupportedStore | undefined;
  const open = () => (store ??= params.openStore());
  const warn = (error: unknown) =>
    params.warn(`anthropic: fast-mode capability state: ${String(error)}`);
  // Loaded on first use so registration never touches plugin runtime state.
  let loaded: Promise<void> | undefined;
  const load = () =>
    (loaded ??= Promise.resolve()
      .then(() => open().entries())
      .then(
        (rows) => {
          for (const row of rows) {
            known.add(row.key);
          }
        },
        (error: unknown) => warn(error),
      ));
  return {
    /** Resolves once stored answers are loaded; lookups before then use the in-process set. */
    ready: load,
    has: (modelId: string) => {
      void load();
      return known.has(modelId);
    },
    record: (modelId: string) => {
      if (known.has(modelId)) {
        return;
      }
      known.add(modelId);
      void Promise.resolve()
        .then(() => open().register(modelId, { learnedAt: Date.now() }))
        .catch(warn);
    },
  };
}
