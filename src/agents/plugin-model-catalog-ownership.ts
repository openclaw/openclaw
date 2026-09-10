import path from "node:path";
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import { isProviderCatalogSourceAllowed } from "../plugins/provider-config-owner.js";
import { isGeneratedPluginModelCatalog } from "./plugin-model-catalog-repair.js";

const PLUGIN_MODEL_CATALOG_FILE = "catalog.json";

export type PluginModelCatalogMetadataSnapshot = Pick<PluginMetadataSnapshot, "owners"> & {
  manifestRegistry?: Pick<PluginMetadataSnapshot["manifestRegistry"], "plugins">;
  index?: {
    plugins: ReadonlyArray<{
      enabled: boolean;
      pluginId: string;
    }>;
  };
  normalizePluginId?: (pluginId: string) => string;
};

/** Encodes the profile-relative path for a plugin-owned generated model catalog. */
export function encodePluginModelCatalogRelativePath(pluginId: string): string {
  return `plugins/${encodeURIComponent(pluginId)}/${PLUGIN_MODEL_CATALOG_FILE}`;
}

/** Returns true only for canonical profile-relative generated catalog paths. */
function isPluginModelCatalogRelativePath(relativePath: string): boolean {
  const parts = relativePath.split(/[\\/]/);
  return (
    !path.isAbsolute(relativePath) &&
    parts.length === 3 &&
    parts[0] === "plugins" &&
    parts[1] !== "" &&
    parts[1] !== "." &&
    parts[1] !== ".." &&
    parts[2] === PLUGIN_MODEL_CATALOG_FILE
  );
}

/** Decodes the plugin id from a canonical generated catalog path. */
export function decodePluginModelCatalogRelativePathPluginId(
  relativePath: string,
): string | undefined {
  if (!isPluginModelCatalogRelativePath(relativePath)) {
    return undefined;
  }
  const encodedPluginId = relativePath.split(/[\\/]/)[1];
  if (!encodedPluginId) {
    return undefined;
  }
  try {
    return decodeURIComponent(encodedPluginId);
  } catch {
    return undefined;
  }
}

/** Resolves the sole enabled plugin that owns a provider's model catalog. */
export function resolvePluginModelCatalogOwnerPluginId(params: {
  providerId: string;
  pluginMetadataSnapshot?: PluginModelCatalogMetadataSnapshot;
}): string | undefined {
  const snapshot = params.pluginMetadataSnapshot;
  const owners = snapshot?.owners;
  if (!owners) {
    return undefined;
  }
  const providerId = normalizeProviderId(params.providerId);
  const candidates = [
    owners.modelCatalogProviders.get(providerId),
    owners.providers.get(providerId),
    owners.setupProviders.get(providerId),
  ].find((entry): entry is readonly string[] => Array.isArray(entry) && entry.length > 0);
  const pluginId = candidates?.length === 1 ? candidates[0] : undefined;
  if (!pluginId) {
    return undefined;
  }
  if (!snapshot?.index) {
    return pluginId;
  }
  const normalizedPluginId = snapshot.normalizePluginId?.(pluginId) ?? pluginId;
  return snapshot.index.plugins.some(
    (plugin) => plugin.pluginId === normalizedPluginId && plugin.enabled,
  )
    ? normalizedPluginId
    : undefined;
}

/** Keeps generated catalog providers only when the catalog plugin still owns them. */
export function filterGeneratedPluginModelCatalogProviders<T>(params: {
  catalogPluginId?: string;
  isProviderAvailable?: (providerId: string) => boolean;
  config?: OpenClawConfig;
  parsedCatalog?: unknown;
  pluginMetadataSnapshot?: PluginModelCatalogMetadataSnapshot;
  providers: Record<string, T>;
}): Record<string, T> {
  if (
    !params.catalogPluginId ||
    !params.pluginMetadataSnapshot ||
    (params.parsedCatalog !== undefined && !isGeneratedPluginModelCatalog(params.parsedCatalog))
  ) {
    return {};
  }
  const plugin = params.pluginMetadataSnapshot.manifestRegistry?.plugins.find(
    (candidate) => candidate.id === params.catalogPluginId,
  );
  const providers = Object.fromEntries(
    Object.entries(params.providers).filter(
      ([providerId]) =>
        resolvePluginModelCatalogOwnerPluginId({
          providerId,
          pluginMetadataSnapshot: params.pluginMetadataSnapshot,
        }) === params.catalogPluginId &&
        isProviderCatalogSourceAllowed({
          provider: providerId,
          config: params.config,
          plugin,
        }),
    ),
  );
  // Captured auth, not the retained catalog's credentials, admits deferred inventory.
  if (
    plugin?.activation?.onStartup === false &&
    params.isProviderAvailable &&
    !Object.keys(providers).some(params.isProviderAvailable)
  ) {
    return {};
  }
  return providers;
}
