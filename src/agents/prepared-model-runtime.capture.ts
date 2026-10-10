import type { Model } from "../llm/types.js";
import type { ModelCatalogSnapshot } from "./model-catalog.types.js";
import { copyPreparedModelRuntimeAuthBindings } from "./prepared-model-runtime-auth.js";
import { mergePreparedNativeCatalog } from "./prepared-model-runtime.catalog-publication.js";
import type { PreparedModelRuntimeSnapshot } from "./prepared-model-runtime.types.js";

const catalogCaptures = new WeakMap<
  PreparedModelRuntimeSnapshot,
  {
    models: ReadonlyMap<string, readonly Model[]> | undefined;
    catalog: ModelCatalogSnapshot | undefined;
    admittedCatalog: ModelCatalogSnapshot;
    capturedSnapshot: PreparedModelRuntimeSnapshot;
    memo: Map<string, Promise<Model>>;
  }
>();

const admittedCatalogs = new WeakMap<PreparedModelRuntimeSnapshot, ModelCatalogSnapshot>();
const admittedPublishedCatalogs = new WeakMap<PreparedModelRuntimeSnapshot, ModelCatalogSnapshot>();

/** Passive inventory captured at admission; the caller must hold the matching turn lease. */
export function readCapturedPreparedModelRuntimeCatalog(
  snapshot: PreparedModelRuntimeSnapshot,
): ModelCatalogSnapshot | undefined {
  return admittedCatalogs.get(snapshot);
}

/** Exact catalog the picker read at admission; route evidence for native-owned models. */
export function readAdmittedPublishedModelCatalog(
  snapshot: PreparedModelRuntimeSnapshot,
): ModelCatalogSnapshot | undefined {
  return admittedPublishedCatalogs.get(snapshot);
}

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
    const hasCatalogFacts =
      catalog &&
      (catalog.entries.length > 0 ||
        catalog.routeVariants.length > 0 ||
        snapshot.modelCatalog.entries.length > 0 ||
        snapshot.modelCatalog.routeVariants.length > 0);
    cached = {
      models,
      catalog,
      admittedCatalog: nativeCatalog
        ? mergePreparedNativeCatalog(catalog, {
            ...catalog,
            entries: [...catalog.entries, ...snapshot.modelCatalog.entries],
            routeVariants: [...catalog.routeVariants, ...snapshot.modelCatalog.routeVariants],
          })
        : (catalog ?? snapshot.modelCatalog),
      // Preserve bare configured owners when there are no capability rows to capture.
      capturedSnapshot: hasCatalogFacts
        ? Object.freeze({
            ...snapshot,
            ...(nativeCatalog
              ? { modelCatalog: mergePreparedNativeCatalog(catalog, snapshot.modelCatalog) }
              : {}),
          })
        : snapshot,
      memo: cached && cached.models === models ? cached.memo : new Map(),
    };
    catalogCaptures.set(snapshot, cached);
  }
  const capturedNative = cached.capturedSnapshot;
  admittedCatalogs.set(capturedNative, cached.admittedCatalog);
  admittedPublishedCatalogs.set(capturedNative, cached.catalog ?? snapshot.modelCatalog);
  if (!models?.size) {
    if (capturedNative !== snapshot) {
      copyPreparedModelRuntimeAuthBindings(snapshot, capturedNative);
    }
    return capturedNative;
  }
  const captured: PreparedModelRuntimeSnapshot = Object.freeze({
    ...capturedNative,
    readPublishedModels: () => models,
    routeModelResolutionMemo: cached.memo,
    createStores: () => {
      const { authStorage, modelRegistry } = snapshot.createStores();
      return { authStorage, modelRegistry: modelRegistry.fork(authStorage, models) };
    },
  });
  copyPreparedModelRuntimeAuthBindings(snapshot, captured);
  admittedCatalogs.set(captured, cached.admittedCatalog);
  admittedPublishedCatalogs.set(captured, cached.catalog ?? snapshot.modelCatalog);
  return captured;
}
