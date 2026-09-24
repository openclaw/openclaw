/** Static SSH adapter and management hooks for the shared remote-shell workspace owner. */
import type {
  CreateSandboxBackendParams,
  SandboxBackendHandle,
  SandboxBackendManager,
} from "./backend.types.js";
import { resolveSandboxConfigForAgent } from "./config.js";
import {
  createRemoteShellSandboxBackend,
  resolveRemoteShellRuntimePaths as resolveSshRuntimePaths,
} from "./remote-shell-backend.js";
import type { RemoteShellSandboxSession } from "./remote-shell-transport.js";
import { sanitizeEnvVars } from "./sanitize-env-vars.js";
import { assertSshSandboxSecretOwnerAvailable } from "./secret-owner.js";
import { resolveSandboxAgentId } from "./shared.js";
import {
  buildRemoteCommand,
  createSshSandboxSessionFromSettings,
  disposeSshSandboxSession,
  prepareSshSandboxExec,
  runSshSandboxCommand,
  uploadDirectoryToSshTarget,
} from "./ssh.js";

/** SSH backend lifecycle hooks for probing and removing remote sandbox copies. */
export const sshSandboxBackendManager: SandboxBackendManager = {
  async describeRuntime({ entry, config, agentId }) {
    const effectiveAgentId = agentId ?? resolveSandboxAgentId(entry.sessionKey);
    const cfg = resolveSandboxConfigForAgent(config, effectiveAgentId);
    if (cfg.backend !== "ssh" || !cfg.ssh.target) {
      return {
        running: false,
        actualConfigLabel: cfg.ssh.target,
        configLabelMatch: false,
      };
    }
    assertSshSandboxSecretOwnerAvailable({
      config,
      scope: cfg.scope,
      agentId: effectiveAgentId,
    });
    const runtimePaths = resolveSshRuntimePaths(cfg.ssh.workspaceRoot, entry.sessionKey);
    const session = await createSshSandboxSessionFromSettings({
      ...cfg.ssh,
      target: cfg.ssh.target,
    });
    try {
      const result = await runSshSandboxCommand({
        session,
        remoteCommand: buildRemoteCommand([
          "/bin/sh",
          "-c",
          'if [ -d "$1" ]; then printf "1\\n"; else printf "0\\n"; fi',
          "openclaw-sandbox-check",
          runtimePaths.runtimeRootDir,
        ]),
      });
      return {
        running: result.stdout.toString("utf8").trim() === "1",
        actualConfigLabel: cfg.ssh.target,
        configLabelMatch: entry.image === cfg.ssh.target,
      };
    } finally {
      await disposeSshSandboxSession(session);
    }
  },
  async removeRuntime({ entry, config, agentId }) {
    const effectiveAgentId = agentId ?? resolveSandboxAgentId(entry.sessionKey);
    const cfg = resolveSandboxConfigForAgent(config, effectiveAgentId);
    if (cfg.backend !== "ssh" || !cfg.ssh.target) {
      return;
    }
    assertSshSandboxSecretOwnerAvailable({
      config,
      scope: cfg.scope,
      agentId: effectiveAgentId,
    });
    const runtimePaths = resolveSshRuntimePaths(cfg.ssh.workspaceRoot, entry.sessionKey);
    const session = await createSshSandboxSessionFromSettings({
      ...cfg.ssh,
      target: cfg.ssh.target,
    });
    try {
      const result = await runSshSandboxCommand({
        session,
        remoteCommand: buildRemoteCommand([
          "/bin/sh",
          "-c",
          'rm -rf -- "$1"',
          "openclaw-sandbox-remove",
          runtimePaths.runtimeRootDir,
        ]),
        allowFailure: true,
      });
      if (result.code !== 0) {
        const detail = result.stderr.toString("utf8").trim() || `exit ${result.code}`;
        throw new Error(`Failed to remove SSH sandbox runtime ${entry.containerName}: ${detail}`);
      }
    } finally {
      await disposeSshSandboxSession(session);
    }
  },
};

async function createSshSandboxBackendInternal(
  params: CreateSandboxBackendParams,
  preprovisionedWorkdir?: { runtimeId: string; remoteWorkspaceDir: string },
): Promise<SandboxBackendHandle> {
  const target = params.cfg.ssh.target;
  if (!target) {
    throw new Error('Sandbox backend "ssh" requires agents.defaults.sandbox.ssh.target.');
  }
  return createRemoteShellSandboxBackend(params, {
    backendId: "ssh",
    configLabel: target,
    configLabelKind: "Target",
    preprovisionedWorkdir,
    createSession: async (): Promise<RemoteShellSandboxSession> => {
      const session = await createSshSandboxSessionFromSettings({ ...params.cfg.ssh, target });
      session.assertCurrent = params.assertRuntimeCurrent;
      return {
        runCommand: (command) => runSshSandboxCommand({ ...command, session }),
        uploadDirectory: (upload) => uploadDirectoryToSshTarget({ ...upload, session }),
        prepareExec: async (exec) => ({
          ...(await prepareSshSandboxExec({ ...exec, session })),
          env: sanitizeEnvVars(process.env).allowed,
        }),
        dispose: () => disposeSshSandboxSession(session),
      };
    },
  });
}

/** Create a static SSH sandbox using the shared remote workspace lifecycle. */
export async function createSshSandboxBackend(
  params: CreateSandboxBackendParams,
): Promise<SandboxBackendHandle> {
  return createSshSandboxBackendInternal(params);
}

/** Adopt a placement-owned worktree without mirroring local files into it. */
export async function createPreprovisionedSshSandboxBackend(
  params: CreateSandboxBackendParams,
  preprovisionedWorkdir: { runtimeId: string; remoteWorkspaceDir: string },
): Promise<SandboxBackendHandle> {
  return createSshSandboxBackendInternal(params, preprovisionedWorkdir);
}

export { resolveSshRuntimePaths };
