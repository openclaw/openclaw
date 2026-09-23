import { deferSqlitePostCommitPublication } from "../../../infra/sqlite-post-commit.js";
import { requestSqliteWorkerOperationAdmission } from "../../../infra/sqlite-worker-operation-admission.js";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import {
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../../../state/openclaw-state-db.js";
import {
  assertSubagentRunExpectedPayloadsInDatabase,
  writeSubagentRunValuesInDatabase,
  type SubagentRegistryWrite,
} from "./subagent-registry.store.kernel.js";

const log = createSubsystemLogger("state/worker");

export function executeSubagentRegistryWrite(
  input: SubagentRegistryWrite,
  writeOptions: OpenClawStateDatabaseOptions,
): { writeId: string } {
  const { writeId, values, deleteRunIds, expectedPayloads } = input;
  let committed = false;
  try {
    runOpenClawStateWriteTransaction((writer) => {
      requestSqliteWorkerOperationAdmission({ stage: "transaction", facts: writeId });
      if (expectedPayloads) {
        assertSubagentRunExpectedPayloadsInDatabase(writer, expectedPayloads);
      }
      writeSubagentRunValuesInDatabase(writer, values, deleteRunIds);
      requestSqliteWorkerOperationAdmission({ stage: "commit", facts: writeId });
      deferSqlitePostCommitPublication(writer.db, () => {
        committed = true;
      });
    }, writeOptions);
  } catch (error) {
    if (!committed) {
      throw error;
    }
    log.warn("Subagent registry write committed before cleanup failed", { error });
  }
  return { writeId };
}
