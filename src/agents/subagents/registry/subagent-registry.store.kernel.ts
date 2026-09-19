import type { Insertable, Updateable } from "kysely";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../../infra/kysely-sync.js";
import type { OpenClawStateDatabase } from "../../../state/openclaw-state-db-contract.js";
import type { DB as OpenClawStateKyselyDatabase } from "../../../state/openclaw-state-db.generated.js";

type SubagentRunsTable = OpenClawStateKyselyDatabase["subagent_runs"];
type SubagentRegistryDatabase = Pick<OpenClawStateKyselyDatabase, "subagent_runs">;
export type BoundSubagentRunRecord = Insertable<SubagentRunsTable>;

export type SubagentRegistryWrite = {
  writeId: string;
  values: readonly BoundSubagentRunRecord[];
  deleteRunIds: readonly string[];
};

/** Upserts a prebound run on the exact supplied shared-state handle. */
export function upsertSubagentRunRowInDatabase(
  database: OpenClawStateDatabase,
  row: BoundSubagentRunRecord,
): void {
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
  values: BoundSubagentRunRecord,
): Updateable<SubagentRunsTable> {
  const { run_id: _runId, ...update } = values;
  return update;
}

/** The caller owns the transaction; both registry writers use this exact row kernel. */
export function writeSubagentRunValuesInDatabase(
  database: OpenClawStateDatabase,
  values: readonly BoundSubagentRunRecord[],
  deleteRunIds?: readonly string[],
  retainedRunIds?: readonly string[],
): void {
  const { db } = database;
  const stateDb = getNodeSqliteKysely<SubagentRegistryDatabase>(db);
  for (const row of values) {
    upsertSubagentRunRowInDatabase(database, row);
  }
  if (retainedRunIds !== undefined) {
    const deleteQuery =
      retainedRunIds.length === 0
        ? stateDb.deleteFrom("subagent_runs")
        : stateDb.deleteFrom("subagent_runs").where("run_id", "not in", retainedRunIds);
    executeSqliteQuerySync(db, deleteQuery);
  } else if (deleteRunIds && deleteRunIds.length > 0) {
    executeSqliteQuerySync(
      db,
      stateDb.deleteFrom("subagent_runs").where("run_id", "in", deleteRunIds),
    );
  }
}
