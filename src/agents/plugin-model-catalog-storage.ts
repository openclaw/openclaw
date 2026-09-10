/** SQLite storage primitives shared by plugin catalog discovery and credential repair. */
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { withOpenClawAgentDatabaseReadOnly } from "../state/openclaw-agent-db-readonly.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../state/openclaw-agent-db.generated.js";
import { runOpenClawAgentWriteTransaction } from "../state/openclaw-agent-db.js";
import {
  resolveAuthProfileDatabaseOwnerId,
  resolveAuthProfileDatabasePath,
} from "./auth-profiles/sqlite.js";
import {
  parseModelCatalogJson,
  rewriteModelCatalogCredentialReferences,
  type ModelCatalogCredentialReference,
} from "./model-catalog-json.js";
import { isGeneratedPluginModelCatalog } from "./plugin-model-catalog-repair.js";

export const PLUGIN_MODEL_CATALOG_CACHE_SCOPE = "plugin-model-catalog-v1";
export const PLUGIN_MODEL_CATALOG_MIGRATION_SCOPE = "plugin-model-catalog-migration-v1";
export type PluginModelCatalogDatabase = Pick<OpenClawAgentKyselyDatabase, "cache_entries">;
export type PersistedPluginModelCatalog = {
  pluginId: string;
  contents: string;
};

export function pluginModelCatalogDatabaseOptions(agentDir: string) {
  return {
    agentId: resolveAuthProfileDatabaseOwnerId(agentDir),
    path: resolveAuthProfileDatabasePath(agentDir),
  };
}

export function readPersistedPluginModelCatalogEntries(
  agentDir: string,
  scope: string,
): PersistedPluginModelCatalog[] {
  const result = withOpenClawAgentDatabaseReadOnly((database) => {
    const kysely = getNodeSqliteKysely<PluginModelCatalogDatabase>(database.db);
    return executeSqliteQuerySync(
      database.db,
      kysely
        .selectFrom("cache_entries")
        .select(["key", "value_json"])
        .where("scope", "=", scope)
        .orderBy("key"),
    ).rows.flatMap((row) =>
      row.value_json === null ? [] : [{ pluginId: row.key, contents: row.value_json }],
    );
  }, pluginModelCatalogDatabaseOptions(agentDir));
  return result.found ? result.value : [];
}

/** Retire verified migration values without replacing another catalog generation. */
export function rewriteVerifiedPluginCatalogCredentials(
  agentDir: string,
  references: readonly ModelCatalogCredentialReference[],
): void {
  if (references.length === 0) {
    return;
  }
  runOpenClawAgentWriteTransaction(
    (database) => {
      const kysely = getNodeSqliteKysely<PluginModelCatalogDatabase>(database.db);
      const rows = executeSqliteQuerySync(
        database.db,
        kysely
          .selectFrom("cache_entries")
          .select(["scope", "key", "value_json"])
          .where("scope", "in", [
            PLUGIN_MODEL_CATALOG_CACHE_SCOPE,
            PLUGIN_MODEL_CATALOG_MIGRATION_SCOPE,
          ]),
      ).rows;
      for (const row of rows) {
        if (row.value_json === null) {
          continue;
        }
        let parsed: unknown;
        try {
          parsed = parseModelCatalogJson(row.value_json);
        } catch {
          // Doctor's collection pass reports malformed catalogs. Preserve them
          // without blocking verified repairs to independent entries.
          continue;
        }
        if (!isGeneratedPluginModelCatalog(parsed)) {
          continue;
        }
        const rewritten = rewriteModelCatalogCredentialReferences(row.value_json, references);
        if (rewritten === row.value_json) {
          continue;
        }
        executeSqliteQuerySync(
          database.db,
          kysely
            .updateTable("cache_entries")
            .set({ value_json: rewritten, updated_at: Date.now() })
            .where("scope", "=", row.scope)
            .where("key", "=", row.key)
            .where("value_json", "=", row.value_json),
        );
      }
    },
    pluginModelCatalogDatabaseOptions(agentDir),
    { operationLabel: "plugin-model-catalog.credentials" },
  );
}
