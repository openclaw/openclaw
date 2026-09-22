import type { Model } from "../llm/types.js";
import { copyPreparedModelRuntimeAuthBindings } from "./prepared-model-runtime-auth.js";
import type { PreparedModelRuntimeSnapshot } from "./prepared-model-runtime.types.js";
import { AuthStorage } from "./sessions/auth-storage.js";

const catalogRouteMemos = new WeakMap<
  PreparedModelRuntimeSnapshot,
  {
    models: ReadonlyMap<string, readonly Model[]>;
    memo: Map<string, Promise<Model>>;
  }
>();

/** Captures executable discovery for a new lease without changing any open lease. */
export function capturePreparedModelRuntimeCatalog(
  snapshot: PreparedModelRuntimeSnapshot,
  models: ReadonlyMap<string, readonly Model[]> | undefined,
): PreparedModelRuntimeSnapshot {
  if (!models?.size) {
    return snapshot;
  }
  let cached = catalogRouteMemos.get(snapshot);
  if (!cached || cached.models !== models) {
    cached = { models, memo: new Map() };
    catalogRouteMemos.set(snapshot, cached);
  }
  const stores = snapshot.createStores();
  const credentials = stores.authStorage.getAll();
  const registry = stores.modelRegistry.fork(stores.authStorage, models);
  const captured: PreparedModelRuntimeSnapshot = Object.freeze({
    ...snapshot,
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
