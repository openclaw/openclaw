import path from "node:path";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  resolveLocalWorkspaceOwner,
  withLocalWorkspaceProjection,
} from "../../gateway/worker-environments/local-workspace-projection.js";
import type { SandboxContext } from "./types.js";

/** A writable project is an exact managed projection, never a role-policy override. */
export async function prepareLocalSandboxWorkspace(params: {
  cfg: OpenClawConfig;
  agentId: string;
  sessionKey: string;
  workspaceDir?: string;
  backend: string;
  assertCurrent?: () => void;
}) {
  const owner = resolveLocalWorkspaceOwner(params);
  if (!owner) {
    return undefined;
  }
  if (params.backend !== "docker" && params.backend !== "podman") {
    throw new Error(
      "Managed guest projects require a local Docker or Podman sandbox; this backend cannot safely reconcile a local managed checkout",
    );
  }
  const workspaceDir = await withLocalWorkspaceProjection(owner, (state) => state.prepare());
  owner.assertCurrent();
  return {
    workspaceDir,
    workspaceCwd: path.join(
      workspaceDir,
      path.relative(owner.worktree.path, params.workspaceDir ?? owner.worktree.path),
    ),
    assertCurrent: owner.assertCurrent,
    provision: async <T>(run: () => Promise<T>) =>
      await withLocalWorkspaceProjection(
        owner,
        async () => {
          owner.assertCurrent();
          const result = await run();
          owner.assertCurrent();
          return result;
        },
        { provision: true },
      ),
    checkpoint: async () => {
      await withLocalWorkspaceProjection(owner, (state) => state.synchronize("canonical"));
    },
  };
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
  const prepareCleanup = backend.prepareProcessCleanup?.bind(backend);
  if (prepareCleanup) {
    backend.prepareProcessCleanup = (env) => {
      projection.assertCurrent();
      return prepareCleanup(env);
    };
  }
  const shell = backend.runShellCommand.bind(backend);
  backend.runShellCommand = async (params) => {
    // Path preparation can await host and container probes after tool entry.
    projection.assertCurrent();
    return await shell(params);
  };
  const build = backend.buildExecSpec.bind(backend);
  const finalize = backend.finalizeExec?.bind(backend);
  backend.buildExecSpec = async (params) => {
    projection.assertCurrent();
    const spec = await build(params);
    try {
      projection.assertCurrent();
    } catch (error) {
      await finalize?.({
        status: "failed",
        exitCode: null,
        timedOut: false,
        token: spec.finalizeToken,
      });
      throw error;
    }
    const assertCurrent = spec.assertCurrent;
    return {
      ...spec,
      assertCurrent: () => {
        projection.assertCurrent();
        assertCurrent?.();
      },
    };
  };
  backend.finalizeExec = async (params) => {
    await finalize?.(params);
    await projection.checkpoint();
  };
  const bridge = sandbox.fsBridge;
  if (!bridge) {
    throw new Error("Managed guest project has no filesystem bridge");
  }
  const mutate = async <T>(operation: () => Promise<T>) => {
    projection.assertCurrent();
    try {
      return await operation();
    } finally {
      await projection.checkpoint();
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
}
