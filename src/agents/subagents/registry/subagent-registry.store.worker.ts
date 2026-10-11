import type { DatabaseSync } from "node:sqlite";
import { readAcpSessionControlInWorker } from "../../../acp/runtime/session-meta-source.worker.js";
import { requestSessionEntryCurrentAdmission } from "../../../config/sessions/session-entry-current-admission.worker.js";
import { getNodeSqliteKysely, iterateSqliteQuerySync } from "../../../infra/kysely-sync.js";
import { isSqliteCorruptionError } from "../../../infra/sqlite-error-diagnostics.js";
import { throwSqliteLifecycleErrors } from "../../../infra/sqlite-lifecycle-errors.js";
import { deferSqlitePostCommitPublication } from "../../../infra/sqlite-post-commit.js";
import { admitSqliteSchema } from "../../../infra/sqlite-schema-facts.js";
import {
  deferSqliteWorkerCommitReceipt,
  requestSqliteWorkerOperationAdmission,
} from "../../../infra/sqlite-worker-operation-admission.js";
import type { WorkerTaskChannel } from "../../../infra/worker-task-server.js";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import {
  recordSessionStateEventInDatabase,
  type SessionStateNotice,
} from "../../../sessions/session-state-events.kernel.js";
import { invalidateOpenClawStateRuntimeIntegrity } from "../../../state/openclaw-state-db-integrity-admission.js";
import {
  assertStateReadSchema,
  openOpenClawStateReadConnection,
} from "../../../state/openclaw-state-db-read-connection.js";
import type { DB as OpenClawStateKyselyDatabase } from "../../../state/openclaw-state-db.generated.js";
import {
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabase,
  type OpenClawStateDatabaseOptions,
} from "../../../state/openclaw-state-db.js";
import type {
  OpenClawStateReadCommand,
  OpenClawStateReadResult,
  OpenClawStateReadRequest,
} from "../../../state/openclaw-state-read.types.js";
import { rowToSubagentRunRecord } from "./subagent-registry.store.codec.js";
import {
  conflictingSubagentRunVersions,
  writeSubagentRunValuesInDatabase,
  type SubagentRegistryWrite,
  type SubagentRegistryWriteReceipt,
} from "./subagent-registry.store.kernel.js";
import { subagentRunRowVersion } from "./subagent-registry.store.row.js";
import {
  loadSubagentMaintenanceRunsInDatabase,
  loadSubagentRunsForSessionsInDatabase,
  loadVersionedSubagentRunsInDatabase,
  loadSubagentRunsForSessionFromSqlite,
} from "./subagent-registry.store.sqlite.js";

const log = createSubsystemLogger("state/worker");

export function readSubagentRunsInWorker(
  db: DatabaseSync,
  command: Extract<OpenClawStateReadCommand, { type: "subagents.runs" }>,
): Extract<OpenClawStateReadResult, { type: "subagents.runs" }> {
  if (command.scope.kind === "maintenance") {
    return {
      type: command.type,
      projection: "maintenance",
      runs: loadSubagentMaintenanceRunsInDatabase({ db }),
    };
  }
  if (command.scope.kind === "descendants") {
    const descendants = loadSubagentRunsForSessionsInDatabase(
      { db },
      command.scope.sessionKeys,
      command.scope.liveTopology,
    );
    return {
      type: command.type,
      runs: descendants.runs,
      descendantBasis: {
        digest: descendants.digest,
        sessionKeys: descendants.sessionKeys,
        runIds: descendants.runIds,
      },
    };
  }
  if (command.scope.kind === "ids") {
    return {
      type: command.type,
      ...loadVersionedSubagentRunsInDatabase({ db }, command.scope.runIds),
    };
  }
  const rows = loadSubagentRunsForSessionFromSqlite(command.scope.sessionKey, { db });
  return { type: command.type, runs: new Map(rows.map((entry) => [entry.runId, entry])) };
}

/** One private reader pins the snapshot; backpressure bounds decoded facts in flight. */
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
    // sqlite-allow-raw -- Keep the complete streamed read on one read-only snapshot.
    db.exec("BEGIN");
    assertStateReadSchema(db, input.databasePath);
    admitSqliteSchema(db);
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
      batch.push({ entry, version: subagentRunRowVersion(row), createdAt: row.created_at });
      bytes += size;
      count += 1;
    }
    if (batch.length) {
      (await channel.request(batch)).consumed();
    }
  } catch (error) {
    if (isSqliteCorruptionError(error)) {
      invalidateOpenClawStateRuntimeIntegrity(db);
    }
    errors.push(error);
  }
  try {
    if (db.isTransaction) {
      db.exec("ROLLBACK"); // sqlite-allow-raw -- End the read snapshot before releasing its reader.
    }
  } catch (error) {
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

/** The row owner's worker adapter commits selected versions and terminal signals together. */
export function persistSubagentRunChangesInWorker(
  input: SubagentRegistryWrite,
  writeOptions: OpenClawStateDatabaseOptions & { database: OpenClawStateDatabase },
): SubagentRegistryWriteReceipt {
  const { writeId, values, deleteRunIds, versions, terminalEvents = [] } = input;
  const admittedRunIds = new Set(versions.map(({ runId }) => runId));
  if (
    [...values.map((row) => row.run_id), ...deleteRunIds].some(
      (runId) => !admittedRunIds.has(runId),
    )
  ) {
    throw new Error("Subagent registry write is missing a row version");
  }
  let committedReceipt: SubagentRegistryWriteReceipt | undefined;
  try {
    return runOpenClawStateWriteTransaction((writer): SubagentRegistryWriteReceipt => {
      requestSqliteWorkerOperationAdmission({ stage: "transaction", facts: writeId });
      const conflictRunIds = conflictingSubagentRunVersions(writer, versions);
      if (conflictRunIds.length > 0) {
        return { writeId, conflictRunIds };
      }
      const admitEvents = (stage: "transaction" | "commit") => {
        for (const [eventIndex, event] of terminalEvents.entries()) {
          requestSessionEntryCurrentAdmission(event.sessionEntryCurrentSource, {
            stage,
            facts: { writeId, eventIndex },
          });
          if (event.acpControl && !readAcpSessionControlInWorker(writer, event.acpControl).row) {
            throw new Error("ACP task owner could not be verified.");
          }
        }
      };
      admitEvents("transaction");
      writeSubagentRunValuesInDatabase(writer, values, deleteRunIds);
      const notices: SessionStateNotice[] = [];
      for (const { event, now } of terminalEvents) {
        notices.push(...recordSessionStateEventInDatabase(writer.db, event, now).notices);
      }
      admitEvents("commit");
      requestSqliteWorkerOperationAdmission({ stage: "commit", facts: writeId });
      const receipt: SubagentRegistryWriteReceipt = {
        writeId,
        versions: new Map([
          ...values.map((row) => [row.run_id, subagentRunRowVersion(row)] as const),
          ...deleteRunIds.map((runId) => [runId, null] as const),
        ]),
        notices,
      };
      deferSqliteWorkerCommitReceipt(writer.db, receipt);
      deferSqlitePostCommitPublication(writer.db, () => {
        committedReceipt = receipt;
      });
      return receipt;
    }, writeOptions);
  } catch (error) {
    if (!committedReceipt) {
      throw error;
    }
    log.warn("Subagent registry write committed before cleanup failed", { error });
    return committedReceipt;
  }
}
