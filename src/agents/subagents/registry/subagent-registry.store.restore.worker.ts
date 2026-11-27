import { getNodeSqliteKysely, iterateSqliteQuerySync } from "../../../infra/kysely-sync.js";
import { isPostgresSqlConnection } from "../../../infra/sql-connection.js";
import { isSqliteCorruptionError } from "../../../infra/sqlite-error-diagnostics.js";
import { throwSqliteLifecycleErrors } from "../../../infra/sqlite-lifecycle-errors.js";
import { admitSqliteSchema } from "../../../infra/sqlite-schema-facts.js";
import type { WorkerTaskChannel } from "../../../infra/worker-task-server.js";
import { invalidateOpenClawStateRuntimeIntegrity } from "../../../state/openclaw-state-db-integrity-admission.js";
import {
  assertStateReadSchema,
  openOpenClawStateReadConnection,
} from "../../../state/openclaw-state-db-read-connection.js";
import type { DB as OpenClawStateKyselyDatabase } from "../../../state/openclaw-state-db.generated.js";
import type { OpenClawStateReadRequest } from "../../../state/openclaw-state-read.types.js";
import { rowToSubagentRunRecord } from "./subagent-registry.store.codec.js";

/** The single SELECT owns its snapshot; backpressure bounds decoded facts in flight. */
export async function streamSubagentRegistryInWorker(
  input: OpenClawStateReadRequest,
  channel: WorkerTaskChannel,
  onAdmitted: () => void,
): Promise<number> {
  const connection = openOpenClawStateReadConnection(
    input.databasePath,
    input.location,
    input.expectedIdentity,
    input.snapshotRoot,
  );
  const { db } = connection.database;
  const errors: unknown[] = [];
  let count = 0;
  try {
    assertStateReadSchema(db, input.databasePath);
    if (!isPostgresSqlConnection(db)) {
      admitSqliteSchema(db);
    }
    onAdmitted();
    const query = getNodeSqliteKysely<Pick<OpenClawStateKyselyDatabase, "subagent_runs">>(db)
      .selectFrom("subagent_runs")
      .selectAll()
      .orderBy("run_id", "asc");
    let batch = [];
    let bytes = 0;
    for (const row of iterateSqliteQuerySync(db, query)) {
      const size = Buffer.byteLength(row.payload_json);
      if (batch.length && (batch.length === 128 || bytes + size > 1024 * 1024)) {
        (await channel.request(batch)).consumed();
        batch = [];
        bytes = 0;
      }
      const entry = rowToSubagentRunRecord(row);
      if (!entry) {
        throw new Error("Canonical subagent restore found an unreadable durable row");
      }
      batch.push({ entry, createdAt: row.created_at });
      bytes += size;
      count += 1;
    }
    if (batch.length) {
      (await channel.request(batch)).consumed();
    }
  } catch (error) {
    if (!isPostgresSqlConnection(db) && isSqliteCorruptionError(error)) {
      invalidateOpenClawStateRuntimeIntegrity(db);
    }
    errors.push(error);
  }
  try {
    connection.close();
  } catch (error) {
    errors.push(error);
  }
  throwSqliteLifecycleErrors(errors, "Subagent restore and reader cleanup failed");
  return count;
}
