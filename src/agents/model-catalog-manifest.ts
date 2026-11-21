import type { NormalizedModelCatalogRow } from "@openclaw/model-catalog-core/model-catalog-types";
import type { ModelProviderConfig } from "../config/types.models.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { planEffectiveModelCatalogRows } from "../model-catalog/index.js";
import { normalizePluginsConfig, type NormalizedPluginsConfig } from "../plugins/config-state.js";
import { isManifestPluginAvailableForControlPlane } from "../plugins/manifest-contract-eligibility.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import { buildEffectiveManifestProviderConfig } from "../plugins/provider-catalog.js";

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

/**
 * Manifest rows that declare existence for the caller's admitted providers. A runtime or
 * refreshable provider's models come only from its account listing; its manifest and hosted
 * rows describe those models, never list them.
 */
export function loadManifestModelProviderConfigs(params: {
  config: OpenClawConfig;
  metadataSnapshot: PluginMetadataSnapshot;
  providerIds: readonly string[];
}): Record<string, ModelProviderConfig> {
  if (params.config.models?.mode === "replace" || params.providerIds.length === 0) {
    return {};
  }
  const { rows, entries } = planEffectiveModelCatalogRows({
    registry: {
      plugins: resolveEligibleManifestCatalogPlugins(params.metadataSnapshot, params.config),
    },
    config: params.config,
    providerFilters: params.providerIds,
  });
  const listedProviders = new Set(
    entries.flatMap(({ provider, discovery }) =>
      discovery === "runtime" || discovery === "refreshable" ? [provider] : [],
    ),
  );
  const rowsByProvider = new Map<string, NormalizedModelCatalogRow[]>();
  for (const row of rows) {
    // Typed-only declarations have no conversational Model defaults or registry entry.
    if (row.inference?.chat === false || listedProviders.has(row.provider)) {
      continue;
    }
    const providerRows = rowsByProvider.get(row.provider) ?? [];
    providerRows.push(row);
    rowsByProvider.set(row.provider, providerRows);
  }
  const providers: Record<string, ModelProviderConfig> = {};
  for (const [provider, providerRows] of rowsByProvider) {
    const providerConfig = buildEffectiveManifestProviderConfig(providerRows);
    if (providerConfig) {
      providers[provider] = providerConfig;
    }
  }
  return providers;
}
