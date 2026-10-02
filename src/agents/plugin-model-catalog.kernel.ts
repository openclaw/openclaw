import type { DatabaseSync } from "node:sqlite";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../state/openclaw-agent-db.generated.js";
import { stripPluginModelCatalogCredentials } from "./plugin-model-catalog-repair.js";

export const PLUGIN_MODEL_CATALOG_CACHE_SCOPE = "plugin-model-catalog-v1";
export const PLUGIN_MODEL_CATALOG_MIGRATION_SCOPE = "plugin-model-catalog-migration-v1";

type PluginModelCatalogDatabase = Pick<OpenClawAgentKyselyDatabase, "cache_entries">;

/** The admitted worker or Doctor transaction owns the connection and commit. */
export function replacePluginModelCatalogEntriesInDatabase(params: {
  database: DatabaseSync;
  planned: ReadonlyMap<string, string>;
  migrationPayloads?: ReadonlyMap<string, string>;
  deleteMissing?: boolean;
  removedCredentials?: ReadonlySet<string>;
  updatedAt: number;
}): boolean {
  const kysely = getNodeSqliteKysely<PluginModelCatalogDatabase>(params.database);
  const existing = executeSqliteQuerySync(
    params.database,
    kysely
      .selectFrom("cache_entries")
      .select(["key", "value_json"])
      .where("scope", "=", PLUGIN_MODEL_CATALOG_CACHE_SCOPE),
  ).rows;
  const existingByPluginId = new Map(existing.map((row) => [row.key, row.value_json]));
  const existingMigrationPayloads = params.migrationPayloads
    ? new Map(
        executeSqliteQuerySync(
          params.database,
          kysely
            .selectFrom("cache_entries")
            .select(["key", "value_json"])
            .where("scope", "=", PLUGIN_MODEL_CATALOG_MIGRATION_SCOPE),
        ).rows.map((row) => [row.key, row.value_json]),
      )
    : undefined;
  const upsertCacheEntry = (scope: string, pluginId: string, contents: string): void => {
    executeSqliteQuerySync(
      params.database,
      kysely
        .insertInto("cache_entries")
        .values({
          scope,
          key: pluginId,
          value_json: contents,
          blob: null,
          expires_at: null,
          updated_at: params.updatedAt,
        })
        .onConflict((conflict) =>
          conflict.columns(["scope", "key"]).doUpdateSet({
            value_json: contents,
            blob: null,
            expires_at: null,
            updated_at: params.updatedAt,
          }),
        ),
    );
  };
  let changed = false;
  for (const [pluginId, plannedContents] of params.planned) {
    const contents = params.removedCredentials?.size
      ? stripPluginModelCatalogCredentials(plannedContents, params.removedCredentials)
      : plannedContents;
    if (contents === null) {
      continue;
    }
    const migrationPayload = params.migrationPayloads?.get(pluginId);
    if (migrationPayload && existingMigrationPayloads?.get(pluginId) === migrationPayload) {
      continue;
    }
    if (existingByPluginId.get(pluginId) !== contents) {
      upsertCacheEntry(PLUGIN_MODEL_CATALOG_CACHE_SCOPE, pluginId, contents);
      changed = true;
    }
    if (migrationPayload) {
      upsertCacheEntry(PLUGIN_MODEL_CATALOG_MIGRATION_SCOPE, pluginId, migrationPayload);
      changed = true;
    }
  }
  if (params.deleteMissing !== false) {
    for (const pluginId of existingByPluginId.keys()) {
      if (params.planned.has(pluginId)) {
        continue;
      }
      executeSqliteQuerySync(
        params.database,
        kysely
          .deleteFrom("cache_entries")
          .where("scope", "=", PLUGIN_MODEL_CATALOG_CACHE_SCOPE)
          .where("key", "=", pluginId),
      );
      changed = true;
    }
  }
  return changed;
}
