import type { DatabaseSync } from "node:sqlite";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import {
  assertTransactionUsable,
  runSqliteWorkerTransactionSync,
} from "../infra/sqlite-transaction.js";
import type { SqliteWorkerBackend } from "../infra/sqlite-worker-contract.js";
import type { SqliteWorkerDatabaseContext } from "../infra/sqlite-worker-database-context.js";
import { normalizePluginProviderBaseUrl } from "../plugins/plugin-metadata-provider-facts.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../state/openclaw-agent-db.generated.js";
import { withExistingOpenClawStateDatabaseCurrentReadOnly } from "../state/openclaw-state-db-readonly.js";
import { loadPersistedAuthProfileStoreAtDatabasePath } from "./auth-profiles/persisted.js";
import { readAuthProfileRows } from "./auth-profiles/sqlite-json.js";
import { loadPersistedAuthProfileStoreFromRows } from "./auth-profiles/sqlite-read.js";
import {
  pluginModelCatalogCredentialValues,
  type PluginModelCatalogAuthSnapshot,
} from "./plugin-model-catalog-auth.js";
import {
  isGeneratedPluginModelCatalog,
  stripPluginModelCatalogCredentials,
} from "./plugin-model-catalog-repair.js";
import {
  PLUGIN_MODEL_CATALOG_CACHE_SCOPE,
  PLUGIN_MODEL_CATALOG_MIGRATION_SCOPE,
  replacePluginModelCatalogEntriesInDatabase,
} from "./plugin-model-catalog.kernel.js";

export type PluginModelCatalogCredentialOperations = {
  "catalog.removeCredentials": { input: { credentials: string[] }; output: void };
  "catalog.pruneRemovedProviders": {
    input: { removedProviderBaseUrls: Record<string, string> };
    output: boolean;
  };
  "catalog.replace": {
    input: {
      planned: Array<[string, string]>;
      authSnapshot?: PluginModelCatalogAuthSnapshot;
      env: NodeJS.ProcessEnv;
    };
    output: boolean;
  };
};

/** Apply removal-time endpoint facts to the current rows inside the writer transaction. */
function pruneRemovedProviderCatalogEntriesInDatabase(params: {
  database: DatabaseSync;
  removedProviderBaseUrls: Readonly<Record<string, string>>;
  updatedAt: number;
}): boolean {
  const removedProviders = Object.entries(params.removedProviderBaseUrls).flatMap(
    ([providerId, baseUrl]) => {
      const normalized = normalizePluginProviderBaseUrl(baseUrl);
      return normalized ? [[providerId, normalized] as const] : [];
    },
  );
  const kysely = getNodeSqliteKysely<Pick<OpenClawAgentKyselyDatabase, "cache_entries">>(
    params.database,
  );
  const rows = executeSqliteQuerySync(
    params.database,
    kysely
      .selectFrom("cache_entries")
      .select(["key", "value_json"])
      .where("scope", "=", PLUGIN_MODEL_CATALOG_CACHE_SCOPE),
  ).rows;
  let changed = false;
  for (const row of rows) {
    if (row.value_json === null) {
      continue;
    }
    let catalog: unknown;
    try {
      catalog = JSON.parse(row.value_json);
    } catch {
      continue;
    }
    if (!isGeneratedPluginModelCatalog(catalog) || !isRecord(catalog.providers)) {
      continue;
    }
    let removed = false;
    for (const [providerId, normalizedBaseUrl] of removedProviders) {
      const provider = catalog.providers[providerId];
      if (
        isRecord(provider) &&
        typeof provider.baseUrl === "string" &&
        normalizePluginProviderBaseUrl(provider.baseUrl) === normalizedBaseUrl
      ) {
        delete catalog.providers[providerId];
        removed = true;
      }
    }
    if (removed) {
      executeSqliteQuerySync(
        params.database,
        kysely
          .updateTable("cache_entries")
          .set({ value_json: JSON.stringify(catalog), updated_at: params.updatedAt })
          .where("scope", "=", PLUGIN_MODEL_CATALOG_CACHE_SCOPE)
          .where("key", "=", row.key),
      );
      changed = true;
    }
  }
  return changed;
}

/** Reread authorization inside the admitted publication, including outside discovery snapshots. */
function findRemovedPluginModelCatalogCredentials(
  snapshot: PluginModelCatalogAuthSnapshot,
  database: DatabaseSync,
  databasePath: string,
  env: NodeJS.ProcessEnv,
): ReadonlySet<string> {
  const captured = new Set<string>();
  const authorized = new Set<string>();
  for (const owner of snapshot) {
    const read = (db: DatabaseSync) =>
      loadPersistedAuthProfileStoreFromRows(
        readAuthProfileRows(db, owner.databasePath, owner.kind),
        owner.databasePath,
      );
    const current =
      owner.kind === "shared-state"
        ? withExistingOpenClawStateDatabaseCurrentReadOnly(({ db }) => read(db), {
            path: owner.databasePath,
            env,
          })
        : owner.databasePath === databasePath
          ? read(database)
          : loadPersistedAuthProfileStoreAtDatabasePath(owner.databasePath, owner.kind);
    for (const [id, values] of Object.entries(owner.credentials)) {
      for (const value of values) {
        captured.add(value);
      }
      for (const value of pluginModelCatalogCredentialValues(current?.profiles[id])) {
        authorized.add(value);
      }
    }
  }
  for (const value of authorized) {
    captured.delete(value);
  }
  return captured;
}

/** The canonical executor lends the connection and owns transaction admission. */
export function bindSqliteWorkerBackend(
  _input: unknown,
  context: SqliteWorkerDatabaseContext,
): SqliteWorkerBackend<PluginModelCatalogCredentialOperations> {
  return {
    execute(command) {
      return runSqliteWorkerTransactionSync(context, () => {
        if (command.type === "catalog.pruneRemovedProviders") {
          return pruneRemovedProviderCatalogEntriesInDatabase({
            database: context.database,
            removedProviderBaseUrls: command.input.removedProviderBaseUrls,
            updatedAt: Date.now(),
          });
        }
        if (command.type === "catalog.replace") {
          const { planned, authSnapshot, env } = command.input;
          const removedCredentials =
            authSnapshot &&
            findRemovedPluginModelCatalogCredentials(
              authSnapshot,
              context.database,
              context.databasePath,
              env,
            );
          return replacePluginModelCatalogEntriesInDatabase({
            database: context.database,
            planned: new Map(planned),
            removedCredentials,
            updatedAt: Date.now(),
          });
        }
        const credentials = new Set(command.input.credentials);
        const kysely = getNodeSqliteKysely<Pick<OpenClawAgentKyselyDatabase, "cache_entries">>(
          context.database,
        );
        const rows = executeSqliteQuerySync(
          context.database,
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
          const contents = stripPluginModelCatalogCredentials(row.value_json, credentials);
          if (contents === row.value_json) {
            continue;
          }
          if (contents === null) {
            executeSqliteQuerySync(
              context.database,
              kysely
                .deleteFrom("cache_entries")
                .where("scope", "=", row.scope)
                .where("key", "=", row.key),
            );
          } else {
            executeSqliteQuerySync(
              context.database,
              kysely
                .updateTable("cache_entries")
                .set({ value_json: contents, updated_at: Date.now() })
                .where("scope", "=", row.scope)
                .where("key", "=", row.key),
            );
          }
        }
        return undefined;
      });
    },
    assertSettled() {
      assertTransactionUsable(context.database);
      if (!context.database.isOpen || context.database.isTransaction) {
        throw new Error("Catalog cleanup left an unsettled agent transaction");
      }
    },
    close() {},
  };
}
