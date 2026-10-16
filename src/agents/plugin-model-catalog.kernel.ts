import { normalizeAgentId } from "@openclaw/normalization-core/agent-id";
import type { Insertable } from "kysely";
import {
  executeSqliteQuerySync,
  getNodeSqliteKysely,
  sqliteStringSet,
} from "../infra/kysely-sync.js";
import type { EngineConnection } from "../infra/sql-connection.js";
import { OpenClawAgentDatabaseReadOnlyScope } from "../state/openclaw-agent-db-readonly-scope.js";
import { withOpenClawAgentDatabaseReadOnly } from "../state/openclaw-agent-db-readonly.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../state/openclaw-agent-db.generated.js";
import { chunkItems } from "../utils/chunk-items.js";
import { stripPluginModelCatalogCredentials } from "./plugin-model-catalog-repair.js";
import {
  createPluginModelCatalogReadOperations,
  type PersistedPluginModelCatalog,
} from "./plugin-model-catalog.read-operation.js";

export type { PersistedPluginModelCatalog } from "./plugin-model-catalog.read-operation.js";

export const PLUGIN_MODEL_CATALOG_CACHE_SCOPE = "plugin-model-catalog-v1";
export const PLUGIN_MODEL_CATALOG_MIGRATION_SCOPE = "plugin-model-catalog-migration-v1";

type PluginModelCatalogDatabase = Pick<OpenClawAgentKyselyDatabase, "cache_entries">;
const CATALOG_WRITE_BATCH_SIZE = 64;
const CATALOG_WRITE_BATCH_BYTES = 1024 * 1024;

export type PluginModelCatalogReplacement = {
  changed: boolean;
  catalogs: PersistedPluginModelCatalog[];
};

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
  database: EngineConnection;
  planned: ReadonlyMap<string, string>;
  migrationPayloads?: ReadonlyMap<string, string>;
  deleteMissing?: boolean;
  removedCredentials?: ReadonlySet<string>;
  updatedAt: number;
}): PluginModelCatalogReplacement {
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
  let pending: Insertable<PluginModelCatalogDatabase["cache_entries"]>[] = [];
  let pendingBytes = 0;
  const upsertCacheEntry = (): void => {
    if (pending.length === 0) {
      return;
    }
    executeSqliteQuerySync(
      params.database,
      kysely
        .insertInto("cache_entries")
        .values(pending)
        .onConflict((conflict) =>
          conflict.columns(["scope", "key"]).doUpdateSet((eb) => ({
            value_json: eb.ref("excluded.value_json"),
            blob: eb.ref("excluded.blob"),
            expires_at: eb.ref("excluded.expires_at"),
            updated_at: eb.ref("excluded.updated_at"),
          })),
        ),
    );
    pending = [];
    pendingBytes = 0;
  };
  const queueCacheEntry = (scope: string, pluginId: string, contents: string): void => {
    const bytes = Buffer.byteLength(contents) + Buffer.byteLength(pluginId);
    // A catalog larger than the byte budget is written alone.
    if (pending.length > 0 && pendingBytes + bytes > CATALOG_WRITE_BATCH_BYTES) {
      upsertCacheEntry();
    }
    pending.push({
      scope,
      key: pluginId,
      value_json: contents,
      blob: null,
      expires_at: null,
      updated_at: params.updatedAt,
    });
    pendingBytes += bytes;
    if (pending.length >= CATALOG_WRITE_BATCH_SIZE || pendingBytes >= CATALOG_WRITE_BATCH_BYTES) {
      upsertCacheEntry();
    }
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
      queueCacheEntry(PLUGIN_MODEL_CATALOG_CACHE_SCOPE, pluginId, contents);
      existingByPluginId.set(pluginId, contents);
      changed = true;
    }
    if (migrationPayload) {
      queueCacheEntry(PLUGIN_MODEL_CATALOG_MIGRATION_SCOPE, pluginId, migrationPayload);
      changed = true;
    }
  }
  upsertCacheEntry();
  if (params.deleteMissing !== false) {
    const removed = [...existingByPluginId.keys()].filter(
      (pluginId) => !params.planned.has(pluginId),
    );
    for (const pluginIds of chunkItems(removed, CATALOG_WRITE_BATCH_SIZE)) {
      executeSqliteQuerySync(
        params.database,
        kysely
          .deleteFrom("cache_entries")
          .where("scope", "=", PLUGIN_MODEL_CATALOG_CACHE_SCOPE)
          .where("key", "in", pluginIds),
      );
      for (const pluginId of pluginIds) {
        existingByPluginId.delete(pluginId);
      }
      changed = true;
    }
  }
  return {
    changed,
    // Match SQLite BINARY and the generated PostgreSQL C collation.
    catalogs: [...existingByPluginId]
      .flatMap(([pluginId, contents]) => (contents === null ? [] : [{ pluginId, contents }]))
      .toSorted((left, right) =>
        Buffer.compare(Buffer.from(left.pluginId), Buffer.from(right.pluginId)),
      ),
  };
}
