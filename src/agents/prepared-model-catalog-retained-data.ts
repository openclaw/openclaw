import {
  getRuntimeConfigSnapshot,
  getRuntimeConfigSourceSnapshot,
} from "../config/runtime-snapshot.js";
import type { DiagnosticWorkerRetainedData } from "../infra/diagnostic-process-types.js";
import { estimateRetainedDataSize } from "../infra/retained-data-size.js";
import {
  captureRemoteModelCatalogStartupSnapshot,
  type ActiveRemoteModelCatalog,
} from "../model-catalog/remote-overlay.js";
import { getPluginRuntimeLoadContext } from "../plugins/runtime/load-context.js";
import { isDeeplyFrozenPlainData } from "../shared/immutable-data.js";
import { measureRuntimeAuthProfileStores } from "./auth-profiles/runtime-snapshots.js";
import type { PreparedModelCatalogWorkerInput } from "./prepared-model-catalog-worker.types.js";
import type { PreparedModelRuntimePluginGeneration } from "./prepared-model-runtime.types.js";

const row = (
  structure: DiagnosticWorkerRetainedData["structure"],
  roots: Iterable<unknown>,
  entries: number,
  counts: Partial<
    Pick<DiagnosticWorkerRetainedData, "generations" | "providers" | "accounts">
  > = {},
): DiagnosticWorkerRetainedData => ({
  structure,
  entries,
  ...counts,
  ...estimateRetainedDataSize(roots),
});

// One weakly-held root set per isolate; diagnostics must not retain a retired catalog.
let remoteCensus:
  | {
      catalogs: WeakRef<ActiveRemoteModelCatalog>[];
      rows: readonly DiagnosticWorkerRetainedData[];
    }
  | undefined;

function measureRemoteCatalogs(
  roots: (ActiveRemoteModelCatalog | null)[],
): readonly DiagnosticWorkerRetainedData[] {
  const catalogs = roots.filter((catalog) => catalog !== null);
  if (
    remoteCensus?.catalogs.length === catalogs.length &&
    remoteCensus.catalogs.every((catalog, index) => catalog.deref() === catalogs[index])
  ) {
    return remoteCensus.rows;
  }
  const rows = [
    row(
      "catalog-remote",
      catalogs.map((catalog) => catalog.providers),
      catalogs.reduce(
        (count, catalog) =>
          count +
          Object.values(catalog.providers).reduce(
            (total, provider) => total + provider.models.length,
            0,
          ),
        0,
      ),
      {
        generations: catalogs.length,
        providers: catalogs.reduce(
          (count, catalog) => count + Object.keys(catalog.providers).length,
          0,
        ),
      },
    ),
    row(
      "catalog-pricing",
      catalogs.flatMap((catalog) => [catalog.pricing, catalog.upstreamPricing]),
      catalogs.reduce(
        (count, catalog) =>
          count + Object.keys(catalog.pricing).length + Object.keys(catalog.upstreamPricing).length,
        0,
      ),
    ),
  ];
  // Transported startup roots can still be mutable. Only immutable publication identities
  // are revisions; preserve one shared traversal budget and deduplication across all roots.
  remoteCensus = catalogs.every(isDeeplyFrozenPlainData)
    ? {
        catalogs: catalogs.map((catalog) => new WeakRef(catalog)),
        rows,
      }
    : undefined;
  return rows;
}

/** Inspect only explicit data roots; registry callbacks and hidden runtime graphs are excluded. */
export function measurePreparedCatalogRetainedData(
  generations: Iterable<PreparedModelRuntimePluginGeneration>,
  request: PreparedModelCatalogWorkerInput | undefined,
): DiagnosticWorkerRetainedData[] {
  const live = [...generations];
  const contexts = live.map((entry) => getPluginRuntimeLoadContext(entry.pluginRegistry));
  const configs = new Set([
    getRuntimeConfigSnapshot(),
    getRuntimeConfigSourceSnapshot(),
    ...contexts.flatMap((context) =>
      context ? [context.rawConfig, context.config, context.activationSourceConfig] : [],
    ),
  ]);
  configs.delete(null);
  const catalogs = new Set([
    captureRemoteModelCatalogStartupSnapshot(),
    ...live.map((entry) => entry.remoteCatalog),
  ]);
  catalogs.delete(null);
  const metadata = new Set(live.map((entry) => entry.pluginMetadataSnapshot));
  const staticCatalogs = live.flatMap(
    (entry) => entry.preparedStaticProviderCatalog?.entries ?? [],
  );
  const staticProviders = staticCatalogs.flatMap((entry) => Object.values(entry.providerConfigs));
  return [
    row("catalog-index", [], live.length, { generations: live.length }),
    row("catalog-config", configs, configs.size),
    row("catalog-metadata", metadata, metadata.size),
    row(
      "catalog-entries",
      live.flatMap((entry) => [entry.inlineProviderModels, entry.configuredCatalogEntries]),
      live.reduce(
        (count, entry) =>
          count + entry.inlineProviderModels.length + entry.configuredCatalogEntries.length,
        0,
      ),
    ),
    row("catalog-static", staticProviders, staticProviders.length, {
      providers: staticProviders.length,
    }),
    ...measureRemoteCatalogs([...catalogs]),
    row("catalog-request", request ? [request] : [], request ? 1 : 0),
    ...measureRuntimeAuthProfileStores(),
  ];
}
