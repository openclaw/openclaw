import { assertCronSandboxStreamSourceInDatabase } from "../../cron/store/stream-source-admission.js";
import { requestSqliteWorkerOperationAdmission } from "../../infra/sqlite-worker-operation-admission.js";
import { captureNamespacedStateLeaseProcessOwner } from "../../infra/state-lease-process-owner.js";
import { createOpenClawStateSchemaEnsurer } from "../../state/openclaw-state-feature-schema-ensure.js";
import type { WorkerWriteOperationContext } from "../../state/worker-operation-registry.js";
import {
  readSandboxPersistentExecsInDatabase,
  writeSandboxPersistentExecInDatabase,
} from "./persistent-exec-store.kernel.js";
import type {
  SandboxPersistentExecWorkspaceBinding,
  SandboxPersistentExecWrite,
} from "./persistent-exec-store.types.js";
import {
  assertSandboxRegistryPersistentExecCurrentInDatabase,
  assertSandboxRegistryWorkspaceBinding,
} from "./registry.kernel.js";

const ensureSchema = createOpenClawStateSchemaEnsurer({
  table: "sandbox_persistent_execs",
  endMarker: "  ON sandbox_persistent_execs(source_identity, owner_key);\n",
  operationLabel: "sandbox.persistent-exec.schema.ensure",
});

function writeSandboxPersistentExec(
  write: SandboxPersistentExecWrite,
  context: WorkerWriteOperationContext,
) {
  const owner = captureNamespacedStateLeaseProcessOwner();
  if (write.operation === "reserve") {
    ensureSchema({ ...context.stateOptions(), database: context.open() });
  }
  return context.write(
    ({ db }) => {
      requestSqliteWorkerOperationAdmission({ stage: "transaction", facts: undefined });
      if ("expectedSource" in write && write.expectedSource) {
        assertCronSandboxStreamSourceInDatabase(db, write.expectedSource);
      }
      let reservationWorkspace: SandboxPersistentExecWorkspaceBinding | undefined;
      if (write.operation === "reserve") {
        const runtime = assertSandboxRegistryPersistentExecCurrentInDatabase(
          db,
          write.input.containerName,
        );
        reservationWorkspace = {
          workspaceDir: runtime.workspaceDir ?? "",
          workspaceSource: runtime.workspaceSource ?? null,
          registryCreatedAtMs: runtime.createdAtMs,
        };
      } else if (
        write.operation === "checkExecutionCurrent" ||
        (write.operation === "transition" &&
          (write.input.phase === "prepared" || write.input.phase === "running"))
      ) {
        const current = readSandboxPersistentExecsInDatabase(db, {
          ownerKey: write.input.ownerKey,
        })[0];
        if (current) {
          const runtime = assertSandboxRegistryPersistentExecCurrentInDatabase(
            db,
            current.containerName,
          );
          assertSandboxRegistryWorkspaceBinding(runtime, current.workspaceBinding);
        }
      }
      const result = writeSandboxPersistentExecInDatabase(db, write, owner, reservationWorkspace);
      requestSqliteWorkerOperationAdmission({ stage: "commit", facts: undefined });
      return result;
    },
    { operationLabel: `sandbox.persistent-exec.${write.operation}` },
  );
}

export const sandboxPersistentExecOperations = {
  "sandboxPersistentExec.write": writeSandboxPersistentExec,
};
