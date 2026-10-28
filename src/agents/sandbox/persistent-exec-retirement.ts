import { stopDockerPersistentExec } from "./docker-persistent-exec.js";
import { createSandboxPersistentExecStore } from "./persistent-exec-store.js";
import type { SandboxPersistentExecRecord } from "./persistent-exec-store.types.js";
import { settleSandboxPersistentExecsForRetirement } from "./persistent-exec.js";
import { readRegistryEntry } from "./registry.js";
import { assertSandboxRegistryWorkspaceBinding } from "./registry.kernel.js";

function expected(record: SandboxPersistentExecRecord) {
  return {
    ownerKey: record.ownerKey,
    attemptId: record.attemptId,
    expectedRevision: record.revision,
  };
}

/** Retirement owns the whole runtime, but must settle its workspace before releasing durable custody. */
export async function prepareSandboxPersistentExecRetirement(params: {
  containerName: string;
  assertCurrent: () => void;
  env?: NodeJS.ProcessEnv;
}): Promise<{ requiresCheckpoint: boolean; finish: () => Promise<void> }> {
  params.assertCurrent();
  const store = createSandboxPersistentExecStore({ env: params.env });
  const original = await store.list({
    containerName: params.containerName,
  });
  const assertWorkspace = async (records: SandboxPersistentExecRecord[]) => {
    if (records.length) {
      const runtime = await readRegistryEntry(params.containerName, {
        path: store.databasePath,
        env: store.environment,
      });
      for (const record of records) {
        assertSandboxRegistryWorkspaceBinding(runtime, record.workspaceBinding);
      }
    }
    params.assertCurrent();
  };
  await assertWorkspace(original);
  let pending = await settleSandboxPersistentExecsForRetirement(params);
  await assertWorkspace(pending.unresolved);
  const proofs = new Map<
    string,
    Awaited<ReturnType<typeof stopDockerPersistentExec>>["extinction"]
  >();
  for (const record of pending.unresolved) {
    const stopped = await stopDockerPersistentExec(
      record.receipt ?? {
        target: record.backendTarget,
        attemptId: record.attemptId,
        parentContainerId: record.containerId,
      },
      params.assertCurrent,
    );
    proofs.set(record.ownerKey, stopped.extinction);
  }
  // Exact child removal fences late START even from another controller. Join
  // local output consumers and checkpoints before transferring cleanup ownership.
  if (pending.unresolved.length) {
    pending = await settleSandboxPersistentExecsForRetirement(params);
  }
  if (pending.unresolved.some((record) => pending.localOwnerKeys.includes(record.ownerKey))) {
    throw new Error(
      "Sandbox stream output or workspace settlement is still pending; runtime custody retained.",
    );
  }
  const stopped: SandboxPersistentExecRecord[] = [];
  for (const record of pending.unresolved) {
    const proof = proofs.get(record.ownerKey);
    if (!proof) {
      throw new Error(
        "Sandbox custody changed during retirement; retry without deleting its workspace.",
      );
    }
    params.assertCurrent();
    const confirmed = await store.confirmContainerExtinction(expected(record), proof);
    if (!confirmed.ok || !confirmed.current) {
      throw new Error("Sandbox cleanup ownership changed during retirement; custody retained.");
    }
    stopped.push(confirmed.current);
  }
  return {
    requiresCheckpoint: stopped.length > 0,
    async finish() {
      await assertWorkspace(original);
      while (stopped.length) {
        const record = stopped[0]!;
        await assertWorkspace([record]);
        const removed = await store.removeConfirmed(expected(record), {
          requireWorkspaceBinding: true,
        });
        if (!removed.ok || removed.current) {
          throw new Error("Sandbox stopped custody changed before release completed.");
        }
        stopped.shift();
      }
    },
  };
}
