const MODEL_CATALOG_STATE_KEY = Symbol.for("openclaw.modelCatalogState");

type ModelCatalogState = {
  writeQueues: Map<string, Promise<void>>;
  readyCache: Map<
    string,
    Promise<{ fingerprint: string; result: { agentDir: string; wrote: boolean } }>
  >;
};

export const MODEL_CATALOG_STATE = (() => {
  const globalState = globalThis as typeof globalThis & {
    [MODEL_CATALOG_STATE_KEY]?: ModelCatalogState;
  };
  if (!globalState[MODEL_CATALOG_STATE_KEY]) {
    globalState[MODEL_CATALOG_STATE_KEY] = {
      writeQueues: new Map<string, Promise<void>>(),
      readyCache: new Map<
        string,
        Promise<{ fingerprint: string; result: { agentDir: string; wrote: boolean } }>
      >(),
    };
  }
  return globalState[MODEL_CATALOG_STATE_KEY];
})();

export function resetModelCatalogReadyCacheForTest(): void {
  MODEL_CATALOG_STATE.writeQueues.clear();
  MODEL_CATALOG_STATE.readyCache.clear();
}
