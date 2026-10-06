import type { DatabaseSync } from "node:sqlite";
import { sql } from "kysely";
import { readAcpSessionControlInWorker } from "../../../acp/runtime/session-meta-source.worker.js";
import { requestSessionEntryCurrentAdmission } from "../../../config/sessions/session-entry-current-admission.worker.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../../infra/kysely-sync.js";
import { deferSqlitePostCommitPublication } from "../../../infra/sqlite-post-commit.js";
import {
  deferSqliteWorkerCommitReceipt,
  requestSqliteWorkerOperationAdmission,
} from "../../../infra/sqlite-worker-operation-admission.js";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import {
  recordSessionStateEventInDatabase,
  type SessionStateNotice,
} from "../../../sessions/session-state-events.kernel.js";
import type { DB as OpenClawStateKyselyDatabase } from "../../../state/openclaw-state-db.generated.js";
import {
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabase,
  type OpenClawStateDatabaseOptions,
} from "../../../state/openclaw-state-db.js";
import type {
  OpenClawStateReadCommand,
  OpenClawStateReadResult,
} from "../../../state/openclaw-state-read.types.js";
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
  if (command.scope.kind === "page") {
    return {
      type: command.type,
      ...readSubagentRegistryPage(db, command.scope.after),
    };
  }
  if (command.scope.kind === "maintenance") {
    const maintenance = loadSubagentMaintenanceRunsInDatabase({ db });
    return {
      type: command.type,
      projection: "maintenance",
      runs: maintenance.runs,
      maintenanceDigest: maintenance.digest,
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

/** Bound worker replies before decoding retained bodies; one oversized record stays whole. */
function readSubagentRegistryPage(db: DatabaseSync, after?: string) {
  const query = getNodeSqliteKysely<Pick<OpenClawStateKyselyDatabase, "subagent_runs">>(db);
  let candidates = query.selectFrom("subagent_runs").select([
    "run_id",
    "created_at",
    /* kysely-allow-raw: byte length bounds registry worker transport without decoding bodies. */
    sql<number>`octet_length(payload_json)`.as("bytes"),
  ]);
  if (after !== undefined) {
    candidates = candidates.where("run_id", ">", after);
  }
  const rows = executeSqliteQuerySync(db, candidates.orderBy("run_id", "asc").limit(128)).rows;
  let bytes = 0;
  const selected = [];
  for (const row of rows) {
    if (selected.length && bytes + row.bytes > 1024 * 1024) {
      break;
    }
    selected.push(row);
    bytes += row.bytes;
  }
  return {
    ...loadVersionedSubagentRunsInDatabase(
      { db },
      selected.map((row) => row.run_id),
    ),
    page: {
      order: selected.map((row) => [row.run_id, row.created_at] as const),
      nextRunId:
        selected.length < rows.length || rows.length === 128 ? selected.at(-1)!.run_id : null,
    },
  };
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
