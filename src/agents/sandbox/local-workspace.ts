import path from "node:path";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  resolveLocalWorkspaceOwner,
  withLocalWorkspaceProjection,
} from "../../gateway/worker-environments/local-workspace-projection.js";
import { withWorktreeAllocationLease } from "../worktrees/allocation.js";
import {
  markManagedWorktreePreparation,
  setWorktreePreparationTemplate,
  startWorktreePreparationPhase,
} from "../worktrees/preparation-timing.js";
import { bindSandboxInputStager, getSandboxInputStager } from "./input-staging.js";
import {
  bindSandboxPersistentExecCapability,
  getSandboxPersistentExecCapability,
} from "./persistent-exec.types.js";
import type { SandboxConfig, SandboxContext } from "./types.js";

export function assertLocalSandboxWorkspaceBackend(backend: SandboxConfig["backend"]) {
  if (backend !== "docker" && backend !== "podman") {
    throw new Error(
      "Managed guest projects require a local Docker or Podman sandbox; this backend cannot safely reconcile a local managed checkout",
    );
  }
}

/** A writable project is an exact managed projection, never a role-policy override. */
export async function prepareLocalSandboxWorkspace(params: {
  cfg: OpenClawConfig;
  agentId: string;
  sessionKey: string;
  workspaceDir?: string;
  sandbox: SandboxConfig;
  signal?: AbortSignal;
  assertCurrent?: () => void;
  assertHost?: () => void;
}) {
  params.assertCurrent?.();
  const owner = await resolveLocalWorkspaceOwner({ ...params, assertCurrent: params.assertHost });
  if (!owner) {
    params.assertCurrent?.();
    return undefined;
  }
  let disposed = false;
  let retained = 0;
  const releaseOwner = () => {
    if (disposed && retained === 0) {
      owner[Symbol.dispose]();
    }
  };
  const retainOwner = () => {
    owner.assertCurrent();
    retained++;
    let released = false;
    return () => {
      if (!released) {
        released = true;
        retained--;
        releaseOwner();
      }
    };
  };
  const assertCurrent = () => {
    params.assertCurrent?.();
    if (disposed) {
      throw new Error("Local sandbox workspace authority changed");
    }
    owner.assertCurrent();
  };
  const executionOwner = {
    ...owner,
    assertCurrent,
    workerAuthority: { ...owner.workerAuthority, assertCurrent },
  };
  let pendingCheckpoint: Promise<void> | undefined;
  const checkpoint = (): Promise<void> => {
    if (pendingCheckpoint) {
      return pendingCheckpoint;
    }
    const pending = withLocalWorkspaceProjection(owner, (state) => {
      // Quiescence is now held. Later requests need their own capture; only
      // requests waiting together for custody can share this checkpoint.
      pendingCheckpoint = undefined;
      return state.synchronize("canonical");
    }).finally(() => {
      if (pendingCheckpoint === pending) {
        pendingCheckpoint = undefined;
      }
    });
    pendingCheckpoint = pending;
    return pending;
  };
  try {
    assertCurrent();
    markManagedWorktreePreparation();
    assertLocalSandboxWorkspaceBackend(params.sandbox.backend);
    const existing = await withLocalWorkspaceProjection(executionOwner, (state) => state.reuse());
    let workspaceDir: string;
    if (existing) {
      setWorktreePreparationTemplate("reused");
      workspaceDir = existing;
    } else if (params.cfg.worktreeAcceleration === false) {
      workspaceDir = await withLocalWorkspaceProjection(executionOwner, (state) => state.prepare());
    } else {
      const allocated = startWorktreePreparationPhase("allocate");
      try {
        workspaceDir = await withWorktreeAllocationLease(
          {
            env: owner.env ?? process.env,
            signal: params.signal,
            commitGuard: assertCurrent,
            workerAuthority: executionOwner.workerAuthority,
          },
          (allocation) => {
            allocated();
            return withLocalWorkspaceProjection(
              { ...executionOwner, workerAuthority: allocation.workerAuthority },
              (state) => state.prepare({ sandbox: params.sandbox, allocation }),
            );
          },
        );
      } finally {
        allocated();
      }
    }
    assertCurrent();
    return {
      workspaceDir,
      workspaceCwd: path.join(
        workspaceDir,
        path.relative(owner.worktree.path, params.workspaceDir ?? owner.worktree.path),
      ),
      assertCurrent,
      retain: () => {
        assertCurrent();
        return retainOwner();
      },
      provision: async <T>(run: () => Promise<T>, signal?: AbortSignal) =>
        await withLocalWorkspaceProjection(
          executionOwner,
          async () => {
            assertCurrent();
            const result = await run();
            assertCurrent();
            return result;
          },
          { provision: true, signal },
        ),
      terminate: async (run: () => Promise<void>) => {
        // Cancellation can join a checkpoint after the exec's finalization has started.
        const release = retainOwner();
        try {
          await withLocalWorkspaceProjection(owner, run, { provision: true });
          // TERM handlers may write after an already-running final checkpoint has completed.
          await checkpoint();
        } finally {
          release();
        }
      },
      // Stop closes execution admission; accepted output still settles under its workspace owner.
      checkpoint,
      [Symbol.dispose]: () => {
        disposed = true;
        releaseOwner();
      },
    };
  } catch (error) {
    owner[Symbol.dispose]();
    throw error;
  }
}

/** All harnesses use the same backend/bridge, including native Codex execution. */
export function bindLocalSandboxWorkspace(
  sandbox: SandboxContext,
  projection: NonNullable<Awaited<ReturnType<typeof prepareLocalSandboxWorkspace>>>,
) {
  const backend = sandbox.backend;
  if (!backend) {
    throw new Error("Managed guest project has no sandbox execution owner");
  }
  const persistent = getSandboxPersistentExecCapability(backend);
  if (persistent) {
    bindSandboxPersistentExecCapability(backend, {
      ...persistent,
      prepare: async (params) => {
        const prepared = await projection.provision(() =>
          persistent.prepare({
            ...params,
            assertCurrent: () => {
              projection.assertCurrent();
              params.assertCurrent();
            },
          }),
        );
        return {
          ...prepared,
          start: (admit: () => Promise<void>) => projection.provision(() => prepared.start(admit)),
        };
      },
    });
  }
  const prepareCleanup = backend.prepareProcessCleanup?.bind(backend);
  if (prepareCleanup) {
    backend.prepareProcessCleanup = (env) => {
      projection.assertCurrent();
      const cleanup = prepareCleanup(env);
      return {
        env: cleanup.env,
        terminate: () => projection.terminate(() => cleanup.terminate()),
        interrupt: (timeoutMs) => {
          const signal = AbortSignal.timeout(timeoutMs);
          const deadline = performance.now() + timeoutMs;
          return projection.provision(() => {
            signal.throwIfAborted();
            return cleanup.interrupt(Math.max(0, Math.ceil(deadline - performance.now())));
          }, signal);
        },
      };
    };
  }
  const shell = backend.runShellCommand.bind(backend);
  backend.runShellCommand = (params) =>
    projection.provision(async () => {
      // A preceding background command may still have the runtime paused for checkpointing.
      params.signal?.throwIfAborted();
      projection.assertCurrent();
      return await shell(params);
    }, params.signal);
  const build = backend.buildExecSpec.bind(backend);
  const finalize = backend.finalizeExec?.bind(backend);
  // Accepted command cleanup keeps its workspace owner after the parent releases its context.
  const finalizations = new Map<unknown, { token: unknown; release: () => void }>();
  backend.buildExecSpec = async (params) => {
    const release = projection.retain();
    let spec: Awaited<ReturnType<typeof build>> | undefined;
    try {
      // Release preparation custody before the command's background lifetime begins.
      const prepared = await projection.provision(async () => {
        projection.assertCurrent();
        spec = await build(params);
        projection.assertCurrent();
        return spec;
      });
      const token = {};
      finalizations.set(token, { token: prepared.finalizeToken, release });
      const assertCurrent = prepared.assertCurrent;
      return {
        ...prepared,
        finalizeToken: token,
        assertCurrent: () => {
          projection.assertCurrent();
          assertCurrent?.();
        },
      };
    } catch (error) {
      try {
        if (spec) {
          await finalize?.({
            status: "failed",
            exitCode: null,
            timedOut: false,
            token: spec.finalizeToken,
          });
        }
      } finally {
        release();
      }
      throw error;
    }
  };
  backend.finalizeExec = async (params) => {
    const pending = finalizations.get(params.token);
    if (!pending) {
      throw new Error("Managed workspace command finalization has no prepared owner");
    }
    finalizations.delete(params.token);
    try {
      await finalize?.({ ...params, token: pending.token });
      await projection.checkpoint();
    } finally {
      pending.release();
    }
  };
  const bridge = sandbox.fsBridge;
  if (!bridge) {
    throw new Error("Managed guest project has no filesystem bridge");
  }
  const mutate = async <T>(operation: () => Promise<T>) => {
    const release = projection.retain();
    try {
      return await operation();
    } finally {
      try {
        await projection.checkpoint();
      } finally {
        release();
      }
    }
  };
  // Decorate the actual instance. Object spreading loses prototype methods,
  // getters and the bridge's private file-identity capability.
  const writeFile = bridge.writeFile.bind(bridge);
  const mkdirp = bridge.mkdirp.bind(bridge);
  const remove = bridge.remove.bind(bridge);
  const rename = bridge.rename.bind(bridge);
  const copyFile = bridge.copyFile?.bind(bridge);
  const createFileExclusive = bridge.createFileExclusive?.bind(bridge);
  bridge.writeFile = (params) => mutate(() => writeFile(params));
  bridge.mkdirp = (params) => mutate(() => mkdirp(params));
  bridge.remove = (params) => mutate(() => remove(params));
  bridge.rename = (params) => mutate(() => rename(params));
  if (copyFile) {
    bridge.copyFile = (params) => mutate(() => copyFile(params));
  }
  if (createFileExclusive) {
    bridge.createFileExclusive = (params) => mutate(() => createFileExclusive(params));
  }
  const stageInput = getSandboxInputStager(bridge);
  if (stageInput) {
    bindSandboxInputStager(bridge, (params) =>
      mutate(() => projection.provision(() => stageInput(params), params.signal)),
    );
  }
}
