import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync, type Dirent } from "node:fs";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { isErrno } from "../infra/errno.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { withOpenClawAgentDatabaseReadOnly } from "../state/openclaw-agent-db-readonly.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../state/openclaw-agent-db.generated.js";
import { runOpenClawAgentWriteTransaction } from "../state/openclaw-agent-db.js";
import {
  resolveAuthProfileDatabaseOwnerId,
  resolveAuthProfileDatabasePath,
} from "./auth-profiles/sqlite.js";
import type { AuthProfileCredential } from "./auth-profiles/types.js";
import { withPluginModelCatalogWriteLockSync } from "./plugin-model-catalog-lock.js";
import { isGeneratedPluginModelCatalog } from "./plugin-model-catalog-repair.js";

const PLUGIN_MODEL_CATALOG_FILE = "catalog.json";
const PLUGIN_MODEL_CATALOG_CACHE_SCOPE = "plugin-model-catalog-v1";
const PLUGIN_MODEL_CATALOG_MIGRATION_SCOPE = "plugin-model-catalog-migration-v1";
export const PLUGIN_MODEL_CATALOG_GENERATION_SCOPE = "plugin-model-catalog-generation-v1";
const PLUGIN_MODEL_CATALOG_GENERATION_KEY = "catalog";
const INITIAL_CATALOG_GENERATION = "initial";

type PluginModelCatalogDatabase = Pick<OpenClawAgentKyselyDatabase, "cache_entries">;

function pluginModelCatalogDatabaseOptions(agentDir: string) {
  return {
    agentId: resolveAuthProfileDatabaseOwnerId(agentDir),
    path: resolveAuthProfileDatabasePath(agentDir),
  };
}

export function readPersistedPluginModelCatalogGeneration(agentDir: string): string {
  const result = withOpenClawAgentDatabaseReadOnly((database) => {
    const kysely = getNodeSqliteKysely<PluginModelCatalogDatabase>(database.db);
    return executeSqliteQuerySync(
      database.db,
      kysely
        .selectFrom("cache_entries")
        .select("value_json")
        .where("scope", "=", PLUGIN_MODEL_CATALOG_GENERATION_SCOPE)
        .where("key", "=", PLUGIN_MODEL_CATALOG_GENERATION_KEY),
    ).rows[0]?.value_json;
  }, pluginModelCatalogDatabaseOptions(agentDir));
  if (!result.found || !result.value) {
    return INITIAL_CATALOG_GENERATION;
  }
  try {
    const parsed = JSON.parse(result.value);
    return isRecord(parsed) && typeof parsed.generation === "string"
      ? parsed.generation
      : INITIAL_CATALOG_GENERATION;
  } catch {
    return INITIAL_CATALOG_GENERATION;
  }
}

export function retireCommittedPluginModelCatalogMigration(params: {
  agentDir: string;
  pluginId: string;
  contents: string;
}): boolean {
  return runOpenClawAgentWriteTransaction(
    (database) => {
      const kysely = getNodeSqliteKysely<PluginModelCatalogDatabase>(database.db);
      const committed = executeSqliteQuerySync(
        database.db,
        kysely
          .selectFrom("cache_entries")
          .select(["scope", "value_json"])
          .where("key", "=", params.pluginId)
          .where("scope", "in", [
            PLUGIN_MODEL_CATALOG_CACHE_SCOPE,
            PLUGIN_MODEL_CATALOG_MIGRATION_SCOPE,
          ]),
      ).rows;
      const contentsByScope = new Map(committed.map((row) => [row.scope, row.value_json]));
      if (
        contentsByScope.get(PLUGIN_MODEL_CATALOG_CACHE_SCOPE) !== params.contents ||
        contentsByScope.get(PLUGIN_MODEL_CATALOG_MIGRATION_SCOPE) !== params.contents
      ) {
        return false;
      }
      executeSqliteQuerySync(
        database.db,
        kysely
          .deleteFrom("cache_entries")
          .where("scope", "=", PLUGIN_MODEL_CATALOG_MIGRATION_SCOPE)
          .where("key", "=", params.pluginId),
      );
      return true;
    },
    pluginModelCatalogDatabaseOptions(params.agentDir),
    { operationLabel: "plugin-model-catalog.retire-migration" },
  );
}

function isPluginModelCatalogMigrationFile(filename: string): boolean {
  return (
    filename === PLUGIN_MODEL_CATALOG_FILE ||
    filename.startsWith(`${PLUGIN_MODEL_CATALOG_FILE}.doctor-importing-`)
  );
}

function readLegacyPluginModelCatalog(pathname: string): string | null {
  try {
    return readFileSync(pathname, "utf8");
  } catch (error) {
    if (isErrno(error) && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

type RetiredCatalogCredential = {
  credential: AuthProfileCredential;
  profileId?: string;
};

/** Strip attributable authentication, not another account's model inventory. */
function rewriteCatalogWithoutCredential(
  contents: string,
  retired: RetiredCatalogCredential,
): {
  contents: string;
  matched: boolean;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    return { contents, matched: false };
  }
  if (!isGeneratedPluginModelCatalog(parsed) || !isRecord(parsed) || !isRecord(parsed.providers)) {
    return { contents, matched: false };
  }
  const credential = retired.credential;
  const values = new Set(
    (credential.type === "api_key"
      ? [credential.key]
      : credential.type === "token"
        ? [credential.token]
        : [credential.access, credential.refresh]
    ).filter((value): value is string => typeof value === "string" && value.length > 0),
  );
  if (retired.profileId) {
    values.add(retired.profileId);
    values.add(`auth-profile:${retired.profileId}`);
  }
  let matched = false;
  const strip = (value: unknown): unknown => {
    if (
      typeof value === "string" &&
      (values.has(value) || (value.startsWith("Bearer ") && values.has(value.slice(7))))
    ) {
      matched = true;
      return undefined;
    }
    if (Array.isArray(value)) {
      return value.map(strip).filter((item) => item !== undefined);
    }
    if (isRecord(value)) {
      return Object.fromEntries(
        Object.entries(value).flatMap(([key, item]) => {
          const clean = strip(item);
          return clean === undefined ? [] : [[key, clean]];
        }),
      );
    }
    return value;
  };
  for (const [provider, entry] of Object.entries(parsed.providers)) {
    if (isRecord(entry)) {
      // Authentication may be provider-wide or carried by per-model headers.
      // Model ids, labels, endpoints, and other metadata must remain authored facts.
      const clean = { ...entry };
      for (const field of ["apiKey", "headers"]) {
        if (field in clean) {
          const value = strip(clean[field]);
          if (value === undefined) {
            delete clean[field];
          } else {
            clean[field] = value;
          }
        }
      }
      if (Array.isArray(clean.models)) {
        clean.models = clean.models.map((model) => {
          if (!isRecord(model)) {
            return model;
          }
          const next = { ...model };
          for (const field of ["apiKey", "headers"]) {
            if (field in next) {
              const value = strip(next[field]);
              if (value === undefined) {
                delete next[field];
              } else {
                next[field] = value;
              }
            }
          }
          return next;
        });
      }
      parsed.providers[provider] = clean;
    }
  }
  return { contents: matched ? JSON.stringify(parsed) : contents, matched };
}

function removeLegacyPluginModelCatalogCredentials(params: {
  agentDir: string;
  retired: RetiredCatalogCredential;
}): number {
  let changed = 0;
  const rewriteFile = (pathname: string) => {
    const contents = readLegacyPluginModelCatalog(pathname);
    if (contents === null) {
      return;
    }
    const rewritten = rewriteCatalogWithoutCredential(contents, params.retired);
    if (!rewritten.matched) {
      return;
    }
    writeFileSync(pathname, rewritten.contents, "utf8");
    changed += 1;
  };
  // An authored root is left byte-for-byte intact by the generated marker check.
  rewriteFile(path.join(params.agentDir, "models.json"));
  const pluginsDir = path.join(params.agentDir, "plugins");
  let pluginDirs: Dirent[];
  try {
    pluginDirs = readdirSync(pluginsDir, { withFileTypes: true });
  } catch (error) {
    if (isErrno(error) && error.code === "ENOENT") {
      return changed;
    }
    throw error;
  }

  for (const pluginDir of pluginDirs) {
    if (!pluginDir.isDirectory()) {
      continue;
    }
    const pluginPath = path.join(pluginsDir, pluginDir.name);
    let catalogFiles: Dirent[];
    try {
      catalogFiles = readdirSync(pluginPath, { withFileTypes: true });
    } catch (error) {
      if (isErrno(error) && error.code === "ENOENT") {
        continue;
      }
      throw error;
    }
    for (const catalogFile of catalogFiles) {
      if (!catalogFile.isFile() || !isPluginModelCatalogMigrationFile(catalogFile.name)) {
        continue;
      }
      rewriteFile(path.join(pluginPath, catalogFile.name));
    }
  }
  return changed;
}

/** Retires only the selected credential's generated copies and invalidates older plans. */
export function removePersistedPluginModelCatalogCredentials(params: {
  agentDirs: readonly string[];
  credential: AuthProfileCredential;
  profileId: string;
  /** Only these stores resolved the reference to the selected physical owner. */
  profileReferenceAgentDirs: readonly string[];
  lockAlreadyHeld?: boolean;
}): number {
  const referenceDirs = new Set(params.profileReferenceAgentDirs.map((dir) => path.resolve(dir)));
  let changedAcrossAgents = 0;
  for (const agentDir of new Set(params.agentDirs.map((dir) => path.resolve(dir)))) {
    const retired: RetiredCatalogCredential = {
      credential: params.credential,
      ...(referenceDirs.has(agentDir) ? { profileId: params.profileId } : {}),
    };
    const run = () => {
      const legacyChanged = removeLegacyPluginModelCatalogCredentials({ agentDir, retired });
      return (
        legacyChanged +
        runOpenClawAgentWriteTransaction(
          (database) => {
            const kysely = getNodeSqliteKysely<PluginModelCatalogDatabase>(database.db);
            const now = Date.now();
            const generation = JSON.stringify({ generation: randomUUID() });
            executeSqliteQuerySync(
              database.db,
              kysely
                .insertInto("cache_entries")
                .values({
                  scope: PLUGIN_MODEL_CATALOG_GENERATION_SCOPE,
                  key: PLUGIN_MODEL_CATALOG_GENERATION_KEY,
                  value_json: generation,
                  blob: null,
                  expires_at: null,
                  updated_at: now,
                })
                .onConflict((conflict) =>
                  conflict.columns(["scope", "key"]).doUpdateSet({
                    value_json: generation,
                    updated_at: now,
                  }),
                ),
            );
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
            let changed = 0;
            for (const row of rows) {
              if (row.value_json === null) {
                continue;
              }
              const rewritten = rewriteCatalogWithoutCredential(row.value_json, retired);
              if (!rewritten.matched) {
                continue;
              }
              executeSqliteQuerySync(
                database.db,
                kysely
                  .updateTable("cache_entries")
                  .set({ value_json: rewritten.contents, updated_at: now })
                  .where("scope", "=", row.scope)
                  .where("key", "=", row.key)
                  .where("value_json", "=", row.value_json),
              );
              changed += 1;
            }
            return changed;
          },
          pluginModelCatalogDatabaseOptions(agentDir),
          { operationLabel: "plugin-model-catalog.logout" },
        )
      );
    };
    changedAcrossAgents += params.lockAlreadyHeld
      ? run()
      : withPluginModelCatalogWriteLockSync(agentDir, run);
  }
  return changedAcrossAgents;
}
