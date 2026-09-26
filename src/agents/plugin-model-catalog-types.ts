/**
 * Leaf contract for persisted provider-owned generated model catalogs.
 *
 * This module holds no imports back into the catalog owner or the handoff so
 * both sides can share the row shape without forming an import cycle.
 */
export type PersistedPluginModelCatalog = {
  pluginId: string;
  contents: string;
};
