import type { SqliteWorkerCommand } from "../../infra/sqlite-worker-contract.js";
import { requestSqliteWorkerOperationAdmission } from "../../infra/sqlite-worker-operation-admission.js";
import {
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../../state/openclaw-state-db.js";
import {
  beginSandboxRegistryRemovalInDatabase,
  reserveSandboxRegistryInDatabase,
  writeSandboxRegistryInDatabase,
  type SandboxRegistryCleanupOperations,
  type SandboxRegistryOperations,
} from "./registry.kernel.js";

export function executeSandboxRegistryCommand(
  command: SqliteWorkerCommand<SandboxRegistryOperations & SandboxRegistryCleanupOperations>,
  options: OpenClawStateDatabaseOptions,
) {
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      requestSqliteWorkerOperationAdmission({ stage: "transaction", facts: undefined });
      const result =
        command.type === "sandboxRegistry.reserve"
          ? reserveSandboxRegistryInDatabase(db, command.input)
          : command.type === "sandboxRegistry.beginRemoval"
            ? beginSandboxRegistryRemovalInDatabase(db, command.input)
            : writeSandboxRegistryInDatabase(
                db,
                command.type === "sandboxRegistry.finishRemoval"
                  ? { operation: "removeGeneration", kind: "container", entry: command.input }
                  : command.input,
              );
      requestSqliteWorkerOperationAdmission({ stage: "commit", facts: undefined });
      return result;
    },
    options,
    { operationLabel: command.type },
  );
}
