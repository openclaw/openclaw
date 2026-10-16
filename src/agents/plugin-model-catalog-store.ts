/**
 * Agent-directory store access for retained provider catalog rows.
 *
 * A shared leaf keeps the catalog facade and the request-owned handoff on one
 * implementation without a dynamic import back into the facade.
 */
import {
  resolveAuthProfileDatabaseOwnerId,
  resolveAuthProfileDatabasePath,
} from "./auth-profiles/sqlite.js";
import {
  PLUGIN_MODEL_CATALOG_CACHE_SCOPE,
  readPluginModelCatalogEntries,
  type PersistedPluginModelCatalog,
} from "./plugin-model-catalog.kernel.js";

export function pluginModelCatalogDatabaseOptions(agentDir: string) {
  return {
    agentId: resolveAuthProfileDatabaseOwnerId(agentDir),
    path: resolveAuthProfileDatabasePath(agentDir),
  };
}

/** Reads the raw retained catalog rows for one agent directory, bounded to a selection when given. */
export function readPersistedPluginModelCatalogs(
  agentDir: string,
  pluginIds?: readonly string[],
): PersistedPluginModelCatalog[] {
  return readPluginModelCatalogEntries(
    pluginModelCatalogDatabaseOptions(agentDir),
    PLUGIN_MODEL_CATALOG_CACHE_SCOPE,
    pluginIds,
  );
}
