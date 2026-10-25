import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { CronSandboxStreamSource } from "../../cron/store/stream-source-admission.js";
import { createSqliteWorkerWriteAdmission } from "../../infra/sqlite-worker-store.js";
import { executeExistingOpenClawStateRead } from "../../state/openclaw-state-db-readonly.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import type {
  SandboxPersistentExecExpected,
  SandboxPersistentExecQuery,
  SandboxPersistentExecRecord,
  SandboxPersistentExecReservation,
  SandboxPersistentExecTransition,
  SandboxPersistentExecWrite,
} from "./persistent-exec-store.types.js";
import type { DockerPersistentExecExtinctionProof } from "./persistent-exec.types.js";

/** One service retains the physical database and its own process custody token. */
export function createSandboxPersistentExecStore(
  options: { assertCurrent?: () => void; env?: NodeJS.ProcessEnv } = {},
) {
  const context = captureOpenClawStateWorkerContext({ env: options.env });
  const ownerToken = randomUUID();
  const assertOwned = () => {
    context.admission.assertCurrent();
    context.maintenanceScope?.assertAdmission();
    options.assertCurrent?.();
  };
  const write = async (command: SandboxPersistentExecWrite, executionGuard?: () => void) => {
    const input = structuredClone(command);
    const assertCurrent = () => {
      assertOwned();
      executionGuard?.();
    };
    assertCurrent();
    const { runOpenClawStateWorkerOperation } =
      await import("../../state/openclaw-state-worker-store.js");
    return runOpenClawStateWorkerOperation(
      context,
      (scope) => scope.execute({ type: "sandboxPersistentExec.write", input }),
      {
        assertCurrent,
        createAdmission: createSqliteWorkerWriteAdmission(assertCurrent, [
          context.admission.databasePath,
        ]),
      },
    );
  };
  const list = async (query: SandboxPersistentExecQuery = {}) => {
    assertOwned();
    const reply = await executeExistingOpenClawStateRead(
      { path: context.admission.databasePath, env: context.environment },
      { type: "sandboxPersistentExec.list", input: structuredClone(query) },
      { context, current: true },
    );
    assertOwned();
    if (!reply) {
      return [];
    }
    if (!reply.ok || reply.type !== "sandboxPersistentExec.list") {
      throw new Error("Unexpected persistent sandbox custody result.");
    }
    return reply.records;
  };
  return {
    databasePath: context.admission.databasePath,
    get custodyScope() {
      assertOwned();
      const identity = context.admission.identity;
      if (!identity.key.startsWith("file:")) {
        throw new Error("Persistent allocation requires an admitted physical database.");
      }
      return createHash("sha256")
        .update(JSON.stringify([identity.key, identity.birthtime]))
        .digest("hex");
    },
    environment: Object.freeze({ ...context.environment }),
    assertCurrent: assertOwned,
    list,
    async assertCustodyCurrent(expected: SandboxPersistentExecRecord) {
      const [current] = await list({ ownerKey: expected.ownerKey });
      if (
        !current ||
        current.attemptId !== expected.attemptId ||
        current.sourceIdentity !== expected.sourceIdentity ||
        current.containerId !== expected.containerId ||
        current.containerName !== expected.containerName ||
        current.containerStartedAt !== expected.containerStartedAt ||
        !isDeepStrictEqual(current.backendTarget, expected.backendTarget) ||
        !isDeepStrictEqual(current.receipt, expected.receipt) ||
        !isDeepStrictEqual(current.workspaceBinding, expected.workspaceBinding)
      ) {
        throw new Error("Persistent sandbox workspace custody changed.");
      }
    },
    reserve(
      input: SandboxPersistentExecReservation,
      assertCurrent: () => void,
      expectedSource?: CronSandboxStreamSource,
    ) {
      return write({ operation: "reserve", ownerToken, input, expectedSource }, assertCurrent);
    },
    transition(
      input: SandboxPersistentExecTransition,
      assertCurrent?: () => void,
      expectedSource?: CronSandboxStreamSource,
    ) {
      return write({ operation: "transition", ownerToken, input, expectedSource }, assertCurrent);
    },
    checkExecutionCurrent(
      input: SandboxPersistentExecExpected,
      expectedSource: CronSandboxStreamSource,
      assertCurrent: () => void,
    ) {
      return write(
        { operation: "checkExecutionCurrent", ownerToken, input, expectedSource },
        assertCurrent,
      );
    },
    claimRecovery(input: SandboxPersistentExecExpected) {
      return write({ operation: "claimRecovery", ownerToken, input });
    },
    async confirmContainerExtinction(
      input: SandboxPersistentExecExpected,
      proof: DockerPersistentExecExtinctionProof,
    ) {
      assertOwned();
      const { readDockerPersistentExecExtinctionProof } =
        await import("./docker-persistent-exec.js");
      const extinction = readDockerPersistentExecExtinctionProof(proof);
      return write(
        { operation: "confirmContainerExtinction", ownerToken, input, extinction },
        () => {
          readDockerPersistentExecExtinctionProof(proof);
        },
      );
    },
    removeConfirmed(
      input: SandboxPersistentExecExpected,
      removal: { requireWorkspaceBinding?: boolean } = {},
    ) {
      return write({
        operation: "removeConfirmed",
        ownerToken,
        input,
        requireWorkspaceBinding: removal.requireWorkspaceBinding,
      });
    },
  };
}
