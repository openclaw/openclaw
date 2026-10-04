import { readAcpSessionControlInWorker } from "../../../acp/runtime/session-meta-source.worker.js";
import { requestSessionEntryCurrentAdmission } from "../../../config/sessions/session-entry-current-admission.worker.js";
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
import {
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabase,
  type OpenClawStateDatabaseOptions,
} from "../../../state/openclaw-state-db.js";
import {
  conflictingSubagentRunVersions,
  writeSubagentRunValuesInDatabase,
  type SubagentRegistryWrite,
  type SubagentRegistryWriteReceipt,
} from "./subagent-registry.store.kernel.js";
import { subagentRunRowVersion } from "./subagent-registry.store.row.js";

const log = createSubsystemLogger("state/worker");

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
