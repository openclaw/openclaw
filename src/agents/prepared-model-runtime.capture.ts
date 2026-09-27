import type { Model } from "../llm/types.js";
import type { ModelCatalogSnapshot } from "./model-catalog.types.js";
import { copyPreparedModelRuntimeAuthBindings } from "./prepared-model-runtime-auth.js";
import { mergePreparedNativeCatalog } from "./prepared-model-runtime.full-catalog.js";
import type { PreparedModelRuntimeSnapshot } from "./prepared-model-runtime.types.js";
import { AuthStorage } from "./sessions/auth-storage.js";

const catalogCaptures = new WeakMap<
  PreparedModelRuntimeSnapshot,
  {
    models: ReadonlyMap<string, readonly Model[]> | undefined;
    catalog: ModelCatalogSnapshot | undefined;
    nativeSnapshot: PreparedModelRuntimeSnapshot;
    memo: Map<string, Promise<Model>>;
  }
>();

/** Captures published executable and native model facts without changing any open lease. */
export function capturePreparedModelRuntimeCatalog(
  snapshot: PreparedModelRuntimeSnapshot,
  source: PreparedModelRuntimeSnapshot | undefined,
): PreparedModelRuntimeSnapshot {
  const models = source?.readPublishedModels?.();
  const catalog = source?.readFullModelCatalog?.();
  let cached = catalogCaptures.get(snapshot);
  if (!cached || cached.models !== models || cached.catalog !== catalog) {
    const nativeCatalog =
      catalog &&
      (catalog.entries.some((entry) => entry.nativeRuntime) ||
        catalog.routeVariants.some((entry) => entry.nativeRuntime));
    cached = {
      models,
      catalog,
      nativeSnapshot: nativeCatalog
        ? Object.freeze({
            ...snapshot,
            modelCatalog: mergePreparedNativeCatalog(catalog, snapshot.modelCatalog),
          })
        : snapshot,
      memo: cached && cached.models === models ? cached.memo : new Map(),
    };
    catalogCaptures.set(snapshot, cached);
  }
  const capturedNative = cached.nativeSnapshot;
  if (!models?.size) {
    if (capturedNative !== snapshot) {
      copyPreparedModelRuntimeAuthBindings(snapshot, capturedNative);
    }
    return capturedNative;
  }
  const stores = snapshot.createStores();
  const credentials = stores.authStorage.getAll();
  const registry = stores.modelRegistry.fork(stores.authStorage, models);
  const captured: PreparedModelRuntimeSnapshot = Object.freeze({
    ...capturedNative,
    readPublishedModels: () => models,
    routeModelResolutionMemo: cached.memo,
    createStores: () => {
      const authStorage = AuthStorage.inMemory(credentials);
      return { authStorage, modelRegistry: registry.fork(authStorage) };
    },
  });
  copyPreparedModelRuntimeAuthBindings(snapshot, captured);
  return captured;
}
