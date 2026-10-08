import type { DatabaseSync } from "node:sqlite";
import { normalizeAgentId } from "@openclaw/normalization-core/agent-id";
import {
  executeSqliteQuerySync,
  getNodeSqliteKysely,
  sqliteStringSet,
} from "../infra/kysely-sync.js";
import { OpenClawAgentDatabaseReadOnlyScope } from "../state/openclaw-agent-db-readonly-scope.js";
import { withOpenClawAgentDatabaseReadOnly } from "../state/openclaw-agent-db-readonly.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../state/openclaw-agent-db.generated.js";
import { stripPluginModelCatalogCredentials } from "./plugin-model-catalog-repair.js";
import {
  createPluginModelCatalogReadOperations,
  type PersistedPluginModelCatalog,
} from "./plugin-model-catalog.read-operation.js";

export type { PersistedPluginModelCatalog } from "./plugin-model-catalog.read-operation.js";

export const PLUGIN_MODEL_CATALOG_CACHE_SCOPE = "plugin-model-catalog-v1";
export const PLUGIN_MODEL_CATALOG_MIGRATION_SCOPE = "plugin-model-catalog-migration-v1";

type PluginModelCatalogDatabase = Pick<OpenClawAgentKyselyDatabase, "cache_entries">;

export function readPluginModelCatalogEntries(
  options: { agentId: string; path: string; env?: NodeJS.ProcessEnv },
  scope: string,
  pluginIds?: readonly string[],
): PersistedPluginModelCatalog[] {
  if (pluginIds?.length === 0) {
    return [];
  }
  const allowed = pluginIds && new Set(pluginIds);
  const result = withOpenClawAgentDatabaseReadOnly(({ db }) => {
    let query = getNodeSqliteKysely<PluginModelCatalogDatabase>(db)
      .selectFrom("cache_entries")
      .select(["key", "value_json"])
      .where("scope", "=", scope)
      .orderBy("key");
    if (pluginIds) {
      query = query.where("key", "in", sqliteStringSet(pluginIds));
    }
    // SQLite binding normalizes lone surrogates; retain exact JS membership so
    // such a selector cannot return a replacement-character catalog.
    return executeSqliteQuerySync(db, query).rows.flatMap((row) =>
      row.value_json === null || (allowed && !allowed.has(row.key))
        ? []
        : [{ pluginId: row.key, contents: row.value_json }],
    );
  }, options);
  return result.found ? result.value : [];
}

export const pluginModelCatalogReadOperations = createPluginModelCatalogReadOperations(
  (input, context) => {
    const scope = new OpenClawAgentDatabaseReadOnlyScope();
    const options = { ...context, agentId: normalizeAgentId(input.agentId) };
    try {
      return scope.run(options, () =>
        readPluginModelCatalogEntries(options, PLUGIN_MODEL_CATALOG_CACHE_SCOPE, input.pluginIds),
      );
    } finally {
      scope.close();
    }
  },
);

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
