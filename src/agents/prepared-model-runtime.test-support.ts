type PreparedModelRuntimeTestApi = {
  resetPreparedModelRuntimeSnapshotsForTest(): Promise<void>;
};

/** Clears prepared model owners when the production module is loaded in this test worker. */
export async function resetPreparedModelRuntimeSnapshotsForTest(): Promise<void> {
  const api = (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.preparedModelRuntimeTestApi")
  ] as PreparedModelRuntimeTestApi | undefined;
  await api?.resetPreparedModelRuntimeSnapshotsForTest();
}

export async function resetPreparedModelCatalogStateForTest(): Promise<void> {
  const { resetModelCatalogBuilderCacheForTest } = await import("./model-catalog.js");
  await resetPreparedModelRuntimeSnapshotsForTest();
  resetModelCatalogBuilderCacheForTest();
}

export async function resetPreparedGatewayModelCatalogForTest(): Promise<void> {
  // Gateway fixtures retain the same model-owner initialization before resetting it.
  await import("../gateway/server-start.js");
  await import("../gateway/server-model-catalog.js");
  await resetPreparedModelCatalogStateForTest();
}
