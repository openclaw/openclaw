import type { SqliteReadOnlyOperationContext } from "../infra/sqlite-readonly-operation-types.js";

export type PersistedPluginModelCatalog = { pluginId: string; contents: string };

export function createPluginModelCatalogReadOperations(
  read: (
    input: { agentId: string; pluginIds?: readonly string[] },
    context: SqliteReadOnlyOperationContext,
  ) => PersistedPluginModelCatalog[],
) {
  return { "pluginCatalog.read": read };
}
