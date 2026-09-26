import { buildModelCatalogMergeKey } from "@openclaw/model-catalog-core/model-catalog-refs";
import type { NormalizedModelCatalogRow } from "@openclaw/model-catalog-core/model-catalog-types";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { planEffectiveModelCatalogRows } from "../model-catalog/index.js";
import { normalizePluginsConfig, type NormalizedPluginsConfig } from "../plugins/config-state.js";
import { isManifestPluginAvailableForControlPlane } from "../plugins/manifest-contract-eligibility.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import { modelCatalogRowToEntry } from "./model-catalog-entry.js";
import type { ModelCatalogEntry } from "./model-catalog.types.js";
import { modelTransportRoutesMatch } from "./model-compat-catalog.js";

type ManifestModelCatalogCacheEntry = {
  snapshot: PluginMetadataSnapshot;
  rows: ModelCatalogEntry[];
  transportRows: readonly NormalizedModelCatalogRow[];
};
let manifestModelCatalogCache = new WeakMap<OpenClawConfig, ManifestModelCatalogCacheEntry>();
export function resetManifestModelCatalogRowsCache() {
  manifestModelCatalogCache = new WeakMap();
}

export function resolveEligibleManifestCatalogPlugins(
  snapshot: PluginMetadataSnapshot,
  config: OpenClawConfig,
): PluginMetadataSnapshot["plugins"] {
  let normalizedConfig: NormalizedPluginsConfig | undefined;
  return snapshot.plugins.filter(
    (plugin) =>
      plugin.modelCatalog &&
      isManifestPluginAvailableForControlPlane({
        snapshot,
        plugin,
        config,
        normalizedConfig:
          config.plugins && (normalizedConfig ??= normalizePluginsConfig(config.plugins)),
      }),
  );
}

export function loadManifestModelCatalogRows(
  config: OpenClawConfig,
  snapshot: PluginMetadataSnapshot,
  preparedPlan?: ReturnType<typeof planEffectiveModelCatalogRows>,
): ModelCatalogEntry[] {
  // Prepared builds also enter here directly; replace must precede cached-row publication.
  if (config.models?.mode === "replace") {
    return [];
  }
  const cached = manifestModelCatalogCache.get(config);
  if (cached?.snapshot === snapshot) {
    return cached.rows;
  }
  const plugins = resolveEligibleManifestCatalogPlugins(snapshot, config);
  const plan =
    preparedPlan ??
    planEffectiveModelCatalogRows({
      registry: { plugins },
      config,
    });
  const providerOrderByKey = new Map<string, number>();
  for (const plugin of plugins) {
    for (const [provider, providerCatalog] of Object.entries(
      plugin.modelCatalog?.providers ?? {},
    )) {
      providerCatalog.models.forEach((model, providerOrder) => {
        const key = buildModelCatalogMergeKey(provider, model.id);
        if (!providerOrderByKey.has(key)) {
          providerOrderByKey.set(key, providerOrder);
        }
      });
    }
  }
  // Global plugin disable does not retire legacy built-in chat compatibility, but it
  // cannot advertise plugin-executed decision tasks as an available capability.
  const rows = plan.rows
    .flatMap((row) => {
      if (config.plugins?.enabled !== false || !row.inference?.decision) {
        return [row];
      }
      return row.inference.chat ? [{ ...row, inference: { chat: true } }] : [];
    })
    .map((row) => {
      const entry = modelCatalogRowToEntry(row);
      const providerOrder = providerOrderByKey.get(buildModelCatalogMergeKey(row.provider, row.id));
      if (providerOrder !== undefined) {
        entry.providerOrder = providerOrder;
      }
      return entry;
    });
  manifestModelCatalogCache.set(config, { snapshot, rows, transportRows: plan.rows });
  return rows;
}

/** Private route defaults from the same captured plan as the public catalog projection. */
export function resolveManifestModelCatalogHeaders(params: {
  config: OpenClawConfig;
  snapshot: PluginMetadataSnapshot;
  model: Pick<ModelCatalogEntry, "provider" | "id" | "baseUrl"> & { api?: string };
}): Record<string, string> | undefined {
  loadManifestModelCatalogRows(params.config, params.snapshot);
  const captured = manifestModelCatalogCache.get(params.config);
  if (params.config.models?.mode === "replace" || captured?.snapshot !== params.snapshot) {
    return undefined;
  }
  const row = captured.transportRows.find(
    (entry) =>
      entry.provider === params.model.provider &&
      entry.id === params.model.id &&
      modelTransportRoutesMatch(entry, params.model),
  );
  return row?.headers;
}
