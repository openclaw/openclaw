import { requestSessionEntryCurrentAdmission } from "../../../config/sessions/session-entry-current-admission.worker.js";
import type { EngineConnection } from "../../../infra/sql-connection.js";
import { deferSqlitePostCommitPublication } from "../../../infra/sqlite-post-commit.js";
import {
  deferSqliteWorkerCommitReceipt,
  requestSqliteWorkerOperationAdmission,
} from "../../../infra/sqlite-worker-operation-admission.js";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import { recordSessionStateEventsInDatabase } from "../../../sessions/session-state-events.kernel.js";
import type { OpenClawStateReadCommand } from "../../../state/openclaw-state-read.types.js";
import type { WorkerWriteOperationContext } from "../../../state/worker-operation-registry.js";
import { writeSubagentRunValuesInDatabase } from "./subagent-registry.store.kernel.js";
import {
  loadSubagentMaintenanceRunsInDatabase,
  loadSubagentRunsForSessionsInDatabase,
  loadSubagentRunsByIdsInDatabase,
  loadSubagentRunsForSessionFromSqlite,
} from "./subagent-registry.store.sqlite.js";
import type {
  SubagentRegistryWrite,
  SubagentRegistryWriteReceipt,
} from "./subagent-registry.store.types.js";
import type { SubagentRunMaintenanceRecord, SubagentRunRecord } from "./subagent-registry.types.js";

const log = createSubsystemLogger("state/worker");

type SubagentRunsReadResult =
  | {
      type: "subagents.runs";
      projection?: never;
      runs: Map<string, SubagentRunRecord>;
      descendants?: { sessionKeys: Set<string>; runIds: readonly string[] };
    }
  | {
      type: "subagents.runs";
      projection: "maintenance";
      runs: Map<string, SubagentRunMaintenanceRecord>;
    };

export function readSubagentRunsInWorker(
  db: EngineConnection,
  command: Extract<OpenClawStateReadCommand, { type: "subagents.runs" }>,
): SubagentRunsReadResult {
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
      descendants: {
        sessionKeys: descendants.sessionKeys,
        runIds: descendants.runIds,
      },
    };
  }
  if (command.scope.kind === "ids") {
    return {
      type: command.type,
      runs: loadSubagentRunsByIdsInDatabase({ db }, command.scope.runIds),
    };
  }
  const rows = loadSubagentRunsForSessionFromSqlite(command.scope.sessionKey, { db });
  return { type: command.type, runs: new Map(rows.map((entry) => [entry.runId, entry])) };
}

/** The row owner's worker adapter commits FIFO-planned rows and terminal signals together. */
export const subagentRegistryOperations = {
  "subagents.persistChanges": (
    input: SubagentRegistryWrite,
    context: WorkerWriteOperationContext,
  ): void => {
    const { writeId, values, deleteRunIds, terminalEvents = [] } = input;
    let committed = false;
    try {
      context.write((writer) => {
        requestSqliteWorkerOperationAdmission({ stage: "transaction", facts: writeId });
        writeSubagentRunValuesInDatabase(writer, values, deleteRunIds);
        const { notices } = recordSessionStateEventsInDatabase(writer.db, terminalEvents);
        for (const [eventIndex, event] of terminalEvents.entries()) {
          requestSessionEntryCurrentAdmission(event.sessionEntryCurrentSource, {
            stage: "commit",
            facts: { writeId, eventIndex },
          });
        }
        requestSqliteWorkerOperationAdmission({ stage: "commit", facts: writeId });
        const receipt: SubagentRegistryWriteReceipt = {
          writeId,
          notices,
        };
        deferSqliteWorkerCommitReceipt(writer.db, receipt);
        deferSqlitePostCommitPublication(writer.db, () => {
          committed = true;
        });
      });
    } catch (error) {
      if (!committed) {
        throw error;
      }
      log.warn("Subagent registry write committed before cleanup failed", { error });
    }
  },
};
