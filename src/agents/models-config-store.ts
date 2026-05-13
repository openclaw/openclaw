import { createHash } from "node:crypto";
import path from "node:path";
import type { Insertable } from "kysely";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";

type ModelsConfigDatabase = Pick<OpenClawStateKyselyDatabase, "agent_model_catalogs">;
type AgentModelCatalogInsert = Insertable<ModelsConfigDatabase["agent_model_catalogs"]>;

type StoredModelsConfigValue = {
  agentDir: string;
  raw: string;
};

function modelsConfigKey(agentDir: string): string {
  return createHash("sha256").update(path.resolve(agentDir)).digest("hex");
}

function modelsConfigToRow(
  agentDir: string,
  raw: string,
  updatedAt: number,
): AgentModelCatalogInsert {
  return {
    catalog_key: modelsConfigKey(agentDir),
    agent_dir: path.resolve(agentDir),
    raw_json: raw,
    updated_at: updatedAt,
  };
}

function rowToStoredModelsConfigValue(row: {
  agent_dir: string;
  raw_json: string;
}): StoredModelsConfigValue {
  return {
    agentDir: row.agent_dir,
    raw: row.raw_json,
  };
}

export function readStoredModelsConfigRaw(
  agentDir: string,
  options: OpenClawStateDatabaseOptions = {},
): { raw: string; updatedAt: number } | undefined {
  const database = openOpenClawStateDatabase(options);
  const db = getNodeSqliteKysely<ModelsConfigDatabase>(database.db);
  const row = executeSqliteQueryTakeFirstSync(
    database.db,
    db
      .selectFrom("agent_model_catalogs")
      .select(["agent_dir", "raw_json", "updated_at"])
      .where("catalog_key", "=", modelsConfigKey(agentDir)),
  );
  if (!row) {
    return undefined;
  }
  const value = rowToStoredModelsConfigValue(row);
  return { raw: value.raw, updatedAt: row.updated_at };
}

export function writeStoredModelsConfigRaw(
  agentDir: string,
  raw: string,
  options: OpenClawStateDatabaseOptions & { now?: () => number } = {},
): void {
  const row = modelsConfigToRow(agentDir, raw, options.now?.() ?? Date.now());
  runOpenClawStateWriteTransaction((database) => {
    const db = getNodeSqliteKysely<ModelsConfigDatabase>(database.db);
    executeSqliteQuerySync(
      database.db,
      db
        .insertInto("agent_model_catalogs")
        .values(row)
        .onConflict((conflict) =>
          conflict.column("catalog_key").doUpdateSet({
            agent_dir: row.agent_dir,
            raw_json: row.raw_json,
            updated_at: row.updated_at,
          }),
        ),
    );
  }, options);
}
