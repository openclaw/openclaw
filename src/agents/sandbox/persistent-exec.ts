import { randomUUID } from "node:crypto";
import type { CronSandboxStreamSource } from "../../cron/store/stream-source-admission.js";
import { formatErrorMessage } from "../../infra/errors.js";
import type { GatewayScheduledJob, GatewayScheduler } from "../../infra/gateway-scheduler.js";
import type { ManagedRun, RunExit } from "../../process/supervisor/types.js";
import { createDeferredCore } from "../../shared/deferred.js";
import type { SandboxBackendHandle } from "./backend-handle.types.js";
import {
  listDockerPersistentExecContainers,
  stopDockerPersistentExec,
} from "./docker-persistent-exec.js";
import { dockerPersistentTargetFromEngineTarget } from "./docker-persistent-target.js";
import { createSandboxPersistentExecStore } from "./persistent-exec-store.js";
import type {
  SandboxPersistentExecExpected,
  SandboxPersistentExecMutationResult,
  SandboxPersistentExecRecord,
} from "./persistent-exec-store.types.js";
import {
  getSandboxPersistentExecCapability,
  type DockerPersistentExecTarget,
  type SandboxPersistentExecPreparation,
  type SandboxPersistentExecStopped,
} from "./persistent-exec.types.js";
import { readRegistry, readRegistryEntry } from "./registry.js";
import { assertSandboxRegistryWorkspaceBinding } from "./registry.kernel.js";

const AUTHORITY_CHECK_INTERVAL_MS = 20_000;
type Store = ReturnType<typeof createSandboxPersistentExecStore>;
type ActiveExecution = {
  databasePath: string;
  containerName: string;
  containerId: string;
  attemptId: string;
  stop: () => Promise<void>;
};

// This is a projection of live custody owners, never recovery or execution authority.
const active = new Map<string, ActiveExecution>();

function expected(record: SandboxPersistentExecRecord): SandboxPersistentExecExpected {
  return {
    ownerKey: record.ownerKey,
    attemptId: record.attemptId,
    expectedRevision: record.revision,
  };
}

function requireRecord(result: SandboxPersistentExecMutationResult): SandboxPersistentExecRecord {
  if (!result.ok || !result.current) {
    throw new Error("Persistent sandbox process custody changed; execution is not permitted.");
  }
  return result.current;
}

async function removeConfirmed(
  store: Store,
  record: SandboxPersistentExecRecord,
  options?: { requireWorkspaceBinding?: boolean },
): Promise<void> {
  const removed = await store.removeConfirmed(expected(record), options);
  if (!removed.ok || removed.current) {
    throw new Error("Persistent sandbox cleanup publication changed; custody retained.");
  }
}

async function settleWorkspace(store: Store, record: SandboxPersistentExecRecord): Promise<void> {
  const assertWorkspace = async () => {
    const runtime = await readRegistryEntry(record.containerName, {
      path: store.databasePath,
      env: store.environment,
    });
    store.assertCurrent();
    assertSandboxRegistryWorkspaceBinding(runtime, record.workspaceBinding);
    return runtime;
  };
  const runtime = await assertWorkspace();
  const { withSettledLocalWorkspaceProjectionPath } =
    await import("../../gateway/worker-environments/local-workspace-settlement.js");
  await withSettledLocalWorkspaceProjectionPath(
    {
      projectionPath: record.workspaceBinding.workspaceDir,
      databasePath: store.databasePath,
      env: store.environment,
      assertCurrent: store.assertCurrent,
      requireProjection: runtime.workspaceSource === "managed-worktree",
    },
    async () => {
      await assertWorkspace();
    },
  );
  // The exact child is extinct. Retain its cleanup receipt until checkpointing,
  // sibling runtime resume, and projection lease settlement have all completed.
  await assertWorkspace();
  await removeConfirmed(store, record, { requireWorkspaceBinding: true });
}

/** Dead-controller recovery only stops the original process; it cannot resume execution. */
async function recoverRecord(
  store: Store,
  previous: SandboxPersistentExecRecord,
): Promise<boolean> {
  const claimed = await store.claimRecovery(expected(previous));
  if (!claimed.ok || !claimed.current) {
    return false;
  }
  let record = claimed.current;
  try {
    if (record.phase !== "stopped") {
      const stopped = await stopDockerPersistentExec(
        record.receipt ?? {
          target: record.backendTarget,
          attemptId: record.attemptId,
          parentContainerId: record.containerId,
        },
        store.assertCurrent,
      );
      record = requireRecord(
        await store.confirmContainerExtinction(expected(record), stopped.extinction),
      );
    }
    await settleWorkspace(store, record);
    return true;
  } catch (error) {
    if (record.phase !== "stopped") {
      await store.transition({
        ...expected(record),
        phase: "uncertain",
        error: formatErrorMessage(error).slice(0, 2048),
      });
    }
    throw error;
  }
}

export async function hasSandboxPersistentExecCustody(params: {
  containerName: string;
  containerId?: string;
}): Promise<boolean> {
  const store = createSandboxPersistentExecStore();
  const records = await store.list(params);
  return (
    records.length > 0 ||
    [...active.values()].some(
      (owner) =>
        owner.databasePath === store.databasePath &&
        owner.containerName === params.containerName &&
        (params.containerId === undefined || params.containerId === owner.containerId),
    )
  );
}

/** Reconcile inert allocations whose controller died before publishing the Docker response. */
export async function recoverSandboxPersistentExecOrphans(
  options: { env?: NodeJS.ProcessEnv } = {},
) {
  const store = createSandboxPersistentExecStore(options);
  await recoverOrphanContainers(store, await store.list());
}

async function recoverOrphanContainers(
  store: Store,
  records: SandboxPersistentExecRecord[],
): Promise<void> {
  const registry = await readRegistry({ path: store.databasePath, env: store.environment });
  const targets = new Map<string, DockerPersistentExecTarget>();
  for (const record of records) {
    targets.set(JSON.stringify(record.backendTarget), record.backendTarget);
  }
  for (const entry of registry.entries) {
    if ((entry.backendId ?? "docker") === "docker" && entry.backendTarget) {
      const target = dockerPersistentTargetFromEngineTarget(entry.backendTarget);
      targets.set(JSON.stringify(target), target);
    }
  }
  for (const target of targets.values()) {
    for (const receipt of await listDockerPersistentExecContainers(target, store.custodyScope)) {
      // Reservation precedes allocation. A fresh read protects another live controller;
      // a late response after deleted custody cannot ever pass durable START admission.
      const current = await store.list();
      store.assertCurrent();
      if (!current.some((record) => record.attemptId === receipt.attemptId)) {
        await stopDockerPersistentExec(receipt, store.assertCurrent);
      }
    }
  }
}

/** Called before taking a workspace settlement lease; ordinary checkpoints keep streams alive. */
export async function settleSandboxPersistentExecsForRetirement(params: {
  containerName: string;
  containerId?: string;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  assertCurrent?: () => void;
}): Promise<{ unresolved: SandboxPersistentExecRecord[]; localOwnerKeys: string[] }> {
  const store = createSandboxPersistentExecStore({ env: params.env });
  params.assertCurrent?.();
  const owners = [...active.values()].filter(
    (owner) =>
      owner.databasePath === store.databasePath &&
      owner.containerName === params.containerName &&
      (params.containerId === undefined || params.containerId === owner.containerId),
  );
  const stopped = await Promise.allSettled(owners.map((owner) => owner.stop()));
  params.assertCurrent?.();
  const unresolved = await store.list({
    containerName: params.containerName,
    containerId: params.containerId,
  });
  // Failed local settlement may include a workspace checkpoint failure even after extinction.
  const failures = stopped.filter(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (failures.length && !unresolved.length) {
    throw new AggregateError(
      failures.map((result) => result.reason),
      "Persistent sandbox workspace settlement failed.",
    );
  }
  const localOwnerKeys = unresolved
    .filter((record) => {
      const owner = active.get(`${store.databasePath}\0${record.ownerKey}`);
      return owner?.attemptId === record.attemptId;
    })
    .map((record) => record.ownerKey);
  return { unresolved, localOwnerKeys };
}

/** One owner holds container custody, current authority, and workspace finalization per attempt. */
export function createSandboxPersistentExecOwner(params: { scheduler: GatewayScheduler }) {
  let retainedStore: Store | undefined;
  const storeForOwner = () => (retainedStore ??= createSandboxPersistentExecStore());

  return {
    async recover(this: void) {
      const store = storeForOwner();
      const records = await store.list();
      const failures: unknown[] = [];
      try {
        await recoverOrphanContainers(store, records);
      } catch (error) {
        failures.push(error);
      }
      for (const record of records) {
        try {
          const owner = active.get(`${store.databasePath}\0${record.ownerKey}`);
          if (owner?.attemptId === record.attemptId) {
            await owner.stop();
          } else {
            await recoverRecord(store, record);
          }
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length) {
        throw new AggregateError(
          failures,
          "Persistent sandbox cleanup is incomplete; affected streams remain blocked.",
        );
      }
    },
    async start(input: {
      ownerKey: string;
      source: CronSandboxStreamSource;
      backend: SandboxBackendHandle;
      argv: readonly string[];
      cwd?: string;
      assertCurrent: () => void;
      signal: AbortSignal;
      onOutput: (stream: "stdout" | "stderr", chunk: Buffer) => void | Promise<void>;
      releaseAuthority: () => void;
    }): Promise<ManagedRun> {
      const store = storeForOwner();
      const capability = getSandboxPersistentExecCapability(input.backend);
      if (!capability) {
        input.releaseAuthority();
        throw new Error(
          "Persistent streams require a supported local Docker sandbox; no host command was started.",
        );
      }
      const cancellation = new AbortController();
      let outputAttached = true;
      const assertCurrent = () => {
        input.signal.throwIfAborted();
        input.assertCurrent();
        if (cancellation.signal.aborted) {
          throw new Error("Persistent sandbox execution has been cancelled.");
        }
      };
      const attemptId = randomUUID();
      const startedAtMs = params.scheduler.now();
      const completion = createDeferredCore<RunExit>();
      const initialization = createDeferredCore();
      void completion.promise.catch(() => {});
      const activity = { resultSettled: false, lastOutputAtMs: startedAtMs };
      let record: SandboxPersistentExecRecord | undefined;
      let preparation: SandboxPersistentExecPreparation | undefined;
      let authorityCheck: GatewayScheduledJob | undefined;
      let authorityCheckFlight: Promise<void> | undefined;
      let settlement: Promise<void> | undefined;
      let finished = false;
      let releasedAuthority = false;
      const activeKey = `${store.databasePath}\0${input.ownerKey}`;
      let activeEntry: ActiveExecution | undefined;
      const releaseAuthority = () => {
        if (!releasedAuthority) {
          releasedAuthority = true;
          input.signal.removeEventListener("abort", onAbort);
          input.releaseAuthority();
        }
      };
      const settle = (): Promise<void> => {
        cancellation.abort(new Error("Persistent sandbox execution has been cancelled."));
        authorityCheck?.cancel();
        authorityCheck = undefined;
        if (finished) {
          return Promise.resolve();
        }
        if (settlement) {
          return settlement;
        }
        settlement = (async () => {
          // Cancellation fences admission immediately, then joins preparation before
          // changing its durable receipt. A late prepare cannot publish after cleanup.
          await initialization.promise;
          // Join any current-authority check before terminal cleanup.
          await authorityCheckFlight?.catch(() => {});
          if (!record) {
            return;
          }
          let stopped: Pick<SandboxPersistentExecStopped, "reason" | "exitCode"> = {
            reason: "cancelled before START",
            exitCode: null,
          };
          try {
            if (record.phase !== "stopped") {
              record = requireRecord(
                await store.transition({ ...expected(record), phase: "stopping" }),
              );
              const result = preparation
                ? await preparation.stop()
                : await stopDockerPersistentExec(
                    record.receipt ?? {
                      target: record.backendTarget,
                      attemptId: record.attemptId,
                      parentContainerId: record.containerId,
                    },
                    store.assertCurrent,
                  );
              stopped = result;
              record = requireRecord(
                await store.confirmContainerExtinction(expected(record), result.extinction),
              );
            }
            await settleWorkspace(store, record);
            finished = true;
            if (active.get(activeKey) === activeEntry) {
              active.delete(activeKey);
            }
            activity.resultSettled = true;
            completion.resolve({
              reason: stopped.reason === "source-exited" ? "exit" : "manual-cancel",
              exitCode: stopped.exitCode,
              exitSignal: null,
              durationMs: Math.max(0, params.scheduler.now() - startedAtMs),
              stdout: "",
              stderr: stopped.reason === "source-exited" ? "" : stopped.reason,
              timedOut: false,
              noOutputTimedOut: false,
            });
          } catch (error) {
            if (record.phase !== "stopped") {
              const updated = await store.transition({
                ...expected(record),
                phase: "uncertain",
                error: formatErrorMessage(error).slice(0, 2048),
              });
              if (updated.ok && updated.current) {
                record = updated.current;
              }
            }
            completion.reject(error);
            throw error;
          } finally {
            releaseAuthority();
          }
        })().finally(() => {
          settlement = undefined;
        });
        return settlement;
      };
      const onAbort = () => {
        void settle().catch(() => {});
      };
      const scheduleAuthorityCheck = () => {
        authorityCheck = params.scheduler.schedule({
          id: `sandbox-persistent:${attemptId}:authority`,
          delayMs: AUTHORITY_CHECK_INTERVAL_MS,
          run: async () => {
            authorityCheck = undefined;
            if (cancellation.signal.aborted || !record || !preparation) {
              return;
            }
            authorityCheckFlight = (async () => {
              assertCurrent();
              requireRecord(
                await store.checkExecutionCurrent(expected(record), input.source, assertCurrent),
              );
              assertCurrent();
              await preparation.checkCurrent();
              assertCurrent();
            })();
            try {
              await authorityCheckFlight;
              if (!cancellation.signal.aborted) {
                scheduleAuthorityCheck();
              }
            } catch {
              // Clearing the flight before settlement avoids joining this callback itself.
              authorityCheckFlight = undefined;
              await settle();
            } finally {
              authorityCheckFlight = undefined;
            }
          },
        });
      };
      try {
        assertCurrent();
        const previousOwner = active.get(activeKey);
        if (previousOwner) {
          await previousOwner.stop();
        }
        for (const previous of await store.list({ ownerKey: input.ownerKey })) {
          if (!(await recoverRecord(store, previous))) {
            throw new Error(
              "A previous sandbox stream still owns process custody; replacement is blocked.",
            );
          }
        }
        assertCurrent();
        record = requireRecord(
          await store.reserve(
            {
              ownerKey: input.ownerKey,
              sourceIdentity: input.source.sourceIdentity,
              attemptId,
              backendId: "docker",
              backendTarget: capability.target,
              containerId: capability.containerId,
              containerName: capability.containerName,
              containerStartedAt: capability.containerStartedAt,
            },
            assertCurrent,
            input.source,
          ),
        );
        activeEntry = {
          databasePath: store.databasePath,
          containerName: capability.containerName,
          containerId: capability.containerId,
          attemptId,
          stop: settle,
        };
        active.set(activeKey, activeEntry);
        preparation = await capability.prepare({
          attemptId,
          custodyScope: store.custodyScope,
          command: { argv: input.argv, cwd: input.cwd },
          assertCurrent,
          signal: AbortSignal.any([input.signal, cancellation.signal]),
          onOutput: async (stream, chunk) => {
            if (!outputAttached) {
              return;
            }
            assertCurrent();
            activity.lastOutputAtMs = params.scheduler.now();
            await input.onOutput(stream, chunk);
          },
        });
        record = requireRecord(
          await store.transition(
            { ...expected(record), phase: "prepared", receipt: preparation.receipt },
            assertCurrent,
            input.source,
          ),
        );
        await preparation.start(async () => {
          assertCurrent();
          if (!record) {
            throw new Error("Persistent sandbox START lost its prepared custody.");
          }
          record = requireRecord(
            await store.transition(
              { ...expected(record), phase: "running" },
              assertCurrent,
              input.source,
            ),
          );
          assertCurrent();
        });
        assertCurrent();
        input.signal.addEventListener("abort", onAbort, { once: true });
        assertCurrent();
        scheduleAuthorityCheck();
        initialization.resolve();
        void preparation.stopped
          .then(
            () => settle(),
            () => settle(),
          )
          .catch(() => {});
        return {
          runId: attemptId,
          startedAtMs,
          activity,
          wait: () => completion.promise,
          waitForExtinction: settle,
          cancel: onAbort,
          detachOutput: () => {
            outputAttached = false;
          },
        };
      } catch (error) {
        initialization.resolve();
        try {
          await settle();
        } catch (cleanupError) {
          throw new AggregateError(
            [error, cleanupError],
            "Sandbox stream start failed and cleanup remains unresolved.",
            { cause: cleanupError },
          );
        } finally {
          releaseAuthority();
        }
        throw error;
      }
    },
  };
}
