import type { DatabaseSync } from "node:sqlite";
import type { Updateable } from "kysely";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../../infra/kysely-sync.js";
import { parseSqliteTableDefinition } from "../../../infra/sqlite-schema-contract-assembly.js";
import {
  getAdmittedSqliteSchemaFacts,
  type SqliteSchemaFacts,
} from "../../../infra/sqlite-schema-facts.js";
import type { SessionStateNotice } from "../../../sessions/session-state-events.kernel.js";
import type { SessionStateWorkerOperations } from "../../../sessions/session-state-events.worker-contract.js";
import type { OpenClawStateDatabase } from "../../../state/openclaw-state-db-contract.js";
import { ensureColumn } from "../../../state/openclaw-state-db-schema-helpers.js";
import type { DB as OpenClawStateKyselyDatabase } from "../../../state/openclaw-state-db.generated.js";
import { subagentRunRowVersion, type SubagentRunSqliteRow } from "./subagent-registry.store.row.js";

type SubagentRunsTable = OpenClawStateKyselyDatabase["subagent_runs"];
type SubagentRegistryDatabase = Pick<OpenClawStateKyselyDatabase, "subagent_runs">;

export type SubagentRegistryWrite = {
  writeId: string;
  values: readonly SubagentRunSqliteRow[];
  deleteRunIds: readonly string[];
  versions: readonly { runId: string; version: string | null }[];
  terminalEvents?: readonly Pick<
    SessionStateWorkerOperations["sessionState.record"]["input"],
    "event" | "now" | "acpControl" | "sessionEntryCurrentSource"
  >[];
};

export type SubagentRegistryWriteReceipt =
  | { writeId: string; conflictRunIds: string[] }
  | { writeId: string; versions: Map<string, string | null>; notices: SessionStateNotice[] };

/** Check every admitted row before any row or companion effect is changed. */
export function conflictingSubagentRunVersions(
  database: OpenClawStateDatabase,
  versions: SubagentRegistryWrite["versions"],
): string[] {
  const stateDb = getNodeSqliteKysely<SubagentRegistryDatabase>(database.db);
  return versions.flatMap(({ runId, version }) => {
    const row = executeSqliteQuerySync(
      database.db,
      stateDb.selectFrom("subagent_runs").selectAll().where("run_id", "=", runId),
    ).rows[0];
    return subagentRunRowVersion(row) === version ? [] : [runId];
  });
}

const parentStoreSchemas = new WeakMap<SqliteSchemaFacts, boolean>();

export function hasParentStoreColumns(db: DatabaseSync): boolean {
  const schema = getAdmittedSqliteSchemaFacts(db);
  if (!schema) {
    throw new Error("Subagent rows require admitted schema facts");
  }
  let present = parentStoreSchemas.get(schema);
  if (present === undefined) {
    const table = schema.tableSql.get("subagent_runs");
    const columns = table ? parseSqliteTableDefinition(table, "subagent_runs").columns : undefined;
    present = Boolean(columns?.has("requester_store_path") && columns.has("controller_store_path"));
    parentStoreSchemas.set(schema, present);
  }
  return present;
}

/** Upserts a prebound run on the exact supplied shared-state handle. */
export function upsertSubagentRunRowInDatabase(
  database: OpenClawStateDatabase,
  row: SubagentRunSqliteRow,
): void {
  if (!hasParentStoreColumns(database.db)) {
    ensureColumn(database.db, "subagent_runs", "requester_store_path TEXT");
    ensureColumn(database.db, "subagent_runs", "controller_store_path TEXT");
  }
  const stateDb = getNodeSqliteKysely<SubagentRegistryDatabase>(database.db);
  executeSqliteQuerySync(
    database.db,
    stateDb
      .insertInto("subagent_runs")
      .values(row)
      .onConflict((conflict) =>
        conflict.column("run_id").doUpdateSet(subagentRunRecordToSqliteUpdate(row)),
      ),
  );
}

/** Deletes one run on the exact supplied shared-state handle. */
export function deleteSubagentRunRowInDatabase(
  database: OpenClawStateDatabase,
  runId: string,
): void {
  executeSqliteQuerySync(
    database.db,
    getNodeSqliteKysely<SubagentRegistryDatabase>(database.db)
      .deleteFrom("subagent_runs")
      .where("run_id", "=", runId),
  );
}

function subagentRunRecordToSqliteUpdate(
  values: SubagentRunSqliteRow,
): Updateable<SubagentRunsTable> {
  const { run_id: _runId, ...update } = values;
  return update;
}

/** Applies selected row changes inside the caller's transaction. */
export function writeSubagentRunValuesInDatabase(
  database: OpenClawStateDatabase,
  values: readonly SubagentRunSqliteRow[],
  deleteRunIds: readonly string[],
): void {
  const { db } = database;
  const stateDb = getNodeSqliteKysely<SubagentRegistryDatabase>(db);
  for (const row of values) {
    upsertSubagentRunRowInDatabase(database, row);
  }
  if (deleteRunIds.length > 0) {
    executeSqliteQuerySync(
      db,
      stateDb.deleteFrom("subagent_runs").where("run_id", "in", deleteRunIds),
    );
  }
}
