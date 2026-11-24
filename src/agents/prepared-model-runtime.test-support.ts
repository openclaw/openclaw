type PreparedModelRuntimeTestApi = {
  resetPreparedModelRuntimeSnapshotsForTest(): Promise<void>;
  setModelRuntimeBuildTimeoutMsForTest(timeoutMs: number): () => void;
};

type ModelCatalogTestApi = {
  resetModelCatalogBuilderCacheForTest(): void;
};

/** Clears prepared model owners when the production module is loaded in this test worker. */
export async function resetPreparedModelRuntimeSnapshotsForTest(): Promise<void> {
  const api = (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.preparedModelRuntimeTestApi")
  ] as PreparedModelRuntimeTestApi | undefined;
  await api?.resetPreparedModelRuntimeSnapshotsForTest();
}

export async function resetPreparedModelCatalogStateForTest(): Promise<void> {
  await resetPreparedModelRuntimeSnapshotsForTest();
  const api = (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.modelCatalogTestApi")
  ] as ModelCatalogTestApi | undefined;
  api?.resetModelCatalogBuilderCacheForTest();
}

/** Scope an integration fixture's real publication deadline without resetting its owners. */
export async function setPreparedModelRuntimeBuildTimeoutForTest(
  timeoutMs: number,
): Promise<() => void> {
  await import("./prepared-model-runtime.js");
  const api = (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.preparedModelRuntimeTestApi")
  ] as PreparedModelRuntimeTestApi;
  return api.setModelRuntimeBuildTimeoutMsForTest(timeoutMs);
}
