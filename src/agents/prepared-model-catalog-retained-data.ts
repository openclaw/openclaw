import {
  getRuntimeConfigSnapshot,
  getRuntimeConfigSourceSnapshot,
} from "../config/runtime-snapshot.js";
import type { DiagnosticWorkerRetainedData } from "../infra/diagnostic-process-types.js";
import { estimateRetainedDataSize } from "../infra/retained-data-size.js";
import { captureRemoteModelCatalogStartupSnapshot } from "../model-catalog/remote-overlay.js";
import { getPluginRuntimeLoadContext } from "../plugins/runtime/load-context.js";
import { measureRuntimeAuthProfileStores } from "./auth-profiles/runtime-snapshots.js";
import type { PreparedModelCatalogWorkerInput } from "./prepared-model-catalog-worker.types.js";
import type { PreparedModelRuntimePluginGeneration } from "./prepared-model-runtime.types.js";

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
    row(
      "catalog-remote",
      [...catalogs].map((catalog) => catalog?.providers),
      [...catalogs].reduce(
        (count, catalog) =>
          count +
          Object.values(catalog?.providers ?? {}).reduce(
            (total, provider) => total + provider.models.length,
            0,
          ),
        0,
      ),
      {
        generations: catalogs.size,
        providers: [...catalogs].reduce(
          (count, catalog) => count + Object.keys(catalog?.providers ?? {}).length,
          0,
        ),
      },
    ),
    row(
      "catalog-pricing",
      [...catalogs].flatMap((catalog) => [catalog?.pricing, catalog?.upstreamPricing]),
      [...catalogs].reduce(
        (count, catalog) =>
          count +
          Object.keys(catalog?.pricing ?? {}).length +
          Object.keys(catalog?.upstreamPricing ?? {}).length,
        0,
      ),
    ),
    row("catalog-request", request ? [request] : [], request ? 1 : 0),
    ...measureRuntimeAuthProfileStores(),
  ];
}
