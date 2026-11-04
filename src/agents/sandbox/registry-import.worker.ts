import { requestSqliteWorkerOperationAdmission } from "../../infra/sqlite-worker-operation-admission.js";
import {
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../../state/openclaw-state-db.js";
import { withSandboxRegistryWorkerReceipt } from "./registry-publication.js";
import {
  insertSandboxRegistryRowIfMissingInDatabase,
  type SandboxRegistryInsert,
} from "./registry.kernel.js";

export function importSandboxRegistryRow(
  row: SandboxRegistryInsert,
  options: OpenClawStateDatabaseOptions,
): void {
  runOpenClawStateWriteTransaction(
    ({ db }) =>
      withSandboxRegistryWorkerReceipt(db, () => {
        requestSqliteWorkerOperationAdmission({ stage: "transaction", facts: undefined });
        insertSandboxRegistryRowIfMissingInDatabase(db, row);
        requestSqliteWorkerOperationAdmission({ stage: "commit", facts: undefined });
      }),
    options,
  );
}
