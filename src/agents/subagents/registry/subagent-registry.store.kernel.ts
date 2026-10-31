import { getPostgresPhysicalFacts } from "../../../infra/database-engine/physical-facts.js";
import {
  executeSqliteQuerySync,
  getNodeSqliteKysely,
  iterateSqliteQuerySync,
} from "../../../infra/kysely-sync.js";
import type { EngineConnection } from "../../../infra/sql-connection.js";
import { getAdmittedSqliteSchemaFacts } from "../../../infra/sqlite-schema-facts.js";
import type { OpenClawStateDatabase } from "../../../state/openclaw-state-db-contract.js";
import { ensureColumn, readTableColumns } from "../../../state/openclaw-state-db-schema-helpers.js";
import type { DB as OpenClawStateKyselyDatabase } from "../../../state/openclaw-state-db.generated.js";
import {
  isSubagentKeepRunArchiveDue,
  SUBAGENT_ARCHIVE_BATCH_BYTES,
  SUBAGENT_ARCHIVE_BATCH_ROWS,
} from "./subagent-registry-work-index.js";
import { rowToSubagentRunRecord } from "./subagent-registry.store.codec.js";
import type { SubagentRunSqliteRow } from "./subagent-registry.store.row.js";

type SubagentRegistryDatabase = Pick<
  OpenClawStateKyselyDatabase,
  "subagent_runs" | "subagent_run_archives"
>;
// Eight bound columns per row keep each statement within 1,024 parameters.
const MAX_SUBAGENT_UPSERT_ROWS = 128;

export function hasParentStoreColumns(db: EngineConnection): boolean {
  const schema = getPostgresPhysicalFacts(db) ?? getAdmittedSqliteSchemaFacts(db);
  if (!schema) {
    throw new Error("Subagent rows require admitted schema facts");
  }
  const columns = readTableColumns(db, "subagent_runs");
  return columns.has("requester_store_path") && columns.has("controller_store_path");
}

/** Applies selected row changes inside the caller's transaction. */
export function writeSubagentRunValuesInDatabase(
  database: OpenClawStateDatabase,
  values: readonly SubagentRunSqliteRow[],
  deleteRunIds: readonly string[],
): boolean {
  const { db } = database;
  const stateDb = getNodeSqliteKysely<SubagentRegistryDatabase>(db);
  if (values.length > 0 && !hasParentStoreColumns(db)) {
    ensureColumn(db, "subagent_runs", "requester_store_path TEXT");
    ensureColumn(db, "subagent_runs", "controller_store_path TEXT");
  }
  for (let offset = 0; offset < values.length; offset += MAX_SUBAGENT_UPSERT_ROWS) {
    executeSqliteQuerySync(
      db,
      stateDb
        .insertInto("subagent_runs")
        .values(values.slice(offset, offset + MAX_SUBAGENT_UPSERT_ROWS))
        .onConflict((conflict) =>
          conflict.column("run_id").doUpdateSet((eb) => ({
            child_session_key: eb.ref("excluded.child_session_key"),
            controller_session_key: eb.ref("excluded.controller_session_key"),
            requester_session_key: eb.ref("excluded.requester_session_key"),
            requester_store_path: eb.ref("excluded.requester_store_path"),
            controller_store_path: eb.ref("excluded.controller_store_path"),
            created_at: eb.ref("excluded.created_at"),
            payload_json: eb.ref("excluded.payload_json"),
          })),
        ),
    );
  }
  if (deleteRunIds.length > 0) {
    executeSqliteQuerySync(
      db,
      stateDb.deleteFrom("subagent_runs").where("run_id", "in", deleteRunIds),
    );
  }
  // Any genuine mutation promotes its row; explicit deletion removes both locations.
  const retiredArchiveIds = [...values.map((row) => row.run_id), ...deleteRunIds];
  let archiveChanged = false;
  for (let offset = 0; offset < retiredArchiveIds.length; offset += MAX_SUBAGENT_UPSERT_ROWS) {
    const deleted = executeSqliteQuerySync(
      db,
      stateDb
        .deleteFrom("subagent_run_archives")
        .where("run_id", "in", retiredArchiveIds.slice(offset, offset + MAX_SUBAGENT_UPSERT_ROWS)),
    );
    archiveChanged ||= (deleted.numAffectedRows ?? 0n) > 0n;
  }
  return archiveChanged;
}

/** Move byte-identical rows in the caller's transaction; an interrupted pass is all-or-nothing. */
export function archiveSubagentRunValuesInDatabase(
  database: OpenClawStateDatabase,
  runIds: readonly string[],
  now: number,
): string[] {
  if (!runIds.length) {
    return [];
  }
  const { db } = database;
  const stateDb = getNodeSqliteKysely<SubagentRegistryDatabase>(db);
  const rows: SubagentRunSqliteRow[] = [];
  let bytes = 0;
  for (const row of iterateSqliteQuerySync(
    db,
    stateDb
      .selectFrom("subagent_runs")
      .selectAll()
      .where("run_id", "in", runIds.slice(0, SUBAGENT_ARCHIVE_BATCH_ROWS))
      .orderBy("run_id"),
  )) {
    const entry = rowToSubagentRunRecord(row);
    if (!entry || !isSubagentKeepRunArchiveDue(entry, now)) {
      continue;
    }
    const size = Buffer.byteLength(row.payload_json);
    if (rows.length && bytes + size > SUBAGENT_ARCHIVE_BATCH_BYTES) {
      break;
    }
    rows.push(row);
    bytes += size;
  }
  if (!rows.length) {
    return [];
  }
  executeSqliteQuerySync(db, stateDb.insertInto("subagent_run_archives").values(rows));
  const archivedRunIds = rows.map((row) => row.run_id);
  executeSqliteQuerySync(
    db,
    stateDb.deleteFrom("subagent_runs").where("run_id", "in", archivedRunIds),
  );
  return archivedRunIds;
}
