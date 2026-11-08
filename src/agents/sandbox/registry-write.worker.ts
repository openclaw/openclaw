import type { EngineConnection } from "../../infra/sql-connection.js";
import { requestSqliteWorkerOperationAdmission } from "../../infra/sqlite-worker-operation-admission.js";
import type { WorkerWriteOperationContext } from "../../state/worker-operation-registry.js";
import { readSandboxPersistentExecsInDatabase } from "./persistent-exec-store.kernel.js";
import { importSandboxRegistryRow } from "./registry-import.worker.js";
import { withSandboxRegistryWorkerReceipt } from "./registry-publication.js";
import {
  beginSandboxRegistryRemovalInDatabase,
  reserveSandboxRegistryInDatabase,
  writeSandboxRegistryInDatabase,
  type SandboxRegistryCleanupOperations,
  type SandboxRegistryInsert,
  type SandboxRegistryOperations,
} from "./registry.kernel.js";

function writeRegistry<T>(
  context: WorkerWriteOperationContext,
  operationLabel: string,
  operation: (db: EngineConnection) => T,
): T {
  return context.write(
    ({ db }) =>
      withSandboxRegistryWorkerReceipt(db, () => {
        requestSqliteWorkerOperationAdmission({ stage: "transaction", facts: undefined });
        const result = operation(db);
        requestSqliteWorkerOperationAdmission({ stage: "commit", facts: undefined });
        return result;
      }),
    { operationLabel },
  );
}

export const sandboxRegistryOperations = {
  "sandboxRegistry.write": (
    input: SandboxRegistryOperations["sandboxRegistry.write"]["input"],
    context: WorkerWriteOperationContext,
  ) =>
    writeRegistry(context, "sandboxRegistry.write", (db) =>
      writeSandboxRegistryInDatabase(db, input),
    ),
  "sandboxRegistry.reserve": (
    input: SandboxRegistryOperations["sandboxRegistry.reserve"]["input"],
    context: WorkerWriteOperationContext,
  ) =>
    writeRegistry(context, "sandboxRegistry.reserve", (db) =>
      reserveSandboxRegistryInDatabase(db, input),
    ),
  "sandboxRegistry.beginRemoval": (
    input: SandboxRegistryOperations["sandboxRegistry.beginRemoval"]["input"],
    context: WorkerWriteOperationContext,
  ) =>
    writeRegistry(context, "sandboxRegistry.beginRemoval", (db) => {
      // Reservation and pruning share the same transaction and durable removal fence.
      if (
        input.preservePersistentExecs &&
        readSandboxPersistentExecsInDatabase(db, { containerName: input.entry.containerName })
          .length
      ) {
        return null;
      }
      return beginSandboxRegistryRemovalInDatabase(db, input);
    }),
  "sandboxRegistry.finishRemoval": (
    input: SandboxRegistryCleanupOperations["sandboxRegistry.finishRemoval"]["input"],
    context: WorkerWriteOperationContext,
  ) =>
    writeRegistry(context, "sandboxRegistry.finishRemoval", (db) =>
      writeSandboxRegistryInDatabase(db, {
        operation: "removeGeneration",
        kind: "container",
        entry: input,
      }),
    ),
  "sandboxRegistry.insertIfMissing": (
    input: SandboxRegistryInsert,
    context: WorkerWriteOperationContext,
  ) => importSandboxRegistryRow(input, { ...context.stateOptions(), database: context.open() }),
};
