import { requestSqliteWorkerOperationAdmission } from "../../infra/sqlite-worker-operation-admission.js";
import {
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../../state/openclaw-state-db.js";
import { writeSandboxRegistryInDatabase, type SandboxRegistryWrite } from "./registry.kernel.js";

export function writeSandboxRegistry(
  write: SandboxRegistryWrite,
  options: OpenClawStateDatabaseOptions,
): void {
  runOpenClawStateWriteTransaction(
    ({ db }) => {
      requestSqliteWorkerOperationAdmission({ stage: "transaction", facts: undefined });
      writeSandboxRegistryInDatabase(db, write);
      requestSqliteWorkerOperationAdmission({ stage: "commit", facts: undefined });
    },
    options,
    { operationLabel: `sandbox.registry.${write.operation}` },
  );
}
