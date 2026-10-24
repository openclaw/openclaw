import { spawnSync } from "node:child_process";
import { vi } from "vitest";
import type { OpenShellSandboxBackend } from "./backend.types.js";
import { resolveOpenShellPluginConfig } from "./config.js";
import { createOpenShellBackendSandboxConfig } from "./openshell.test-support.js";

export const cliMocks = {
  runOpenShellCli: vi.fn(),
  createOpenShellSshSession: vi.fn(),
};

export const sandboxMocks = {
  runSshSandboxCommand: vi.fn(),
  disposeSshSandboxSession: vi.fn(),
  prepareSshSandboxExec: vi.fn(),
  cleanupPreparedExec: vi.fn(),
  remoteRoot: "",
  remoteAgentRoot: "",
};

export let createOpenShellSandboxBackendManager: typeof import("./backend.js").createOpenShellSandboxBackendManager;
export let createOpenShellSandboxBackendFactory: typeof import("./backend.js").createOpenShellSandboxBackendFactory;

export async function installOpenShellBackendMocks() {
  vi.doMock("openclaw/plugin-sdk/sandbox", async (importOriginal) => ({
    ...(await importOriginal<typeof import("openclaw/plugin-sdk/sandbox")>()),
    disposeSshSandboxSession: sandboxMocks.disposeSshSandboxSession,
    prepareSshSandboxExec: sandboxMocks.prepareSshSandboxExec,
    runSshSandboxCommand: sandboxMocks.runSshSandboxCommand,
  }));
  vi.doMock("./cli.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("./cli.js")>()),
    ...cliMocks,
  }));
  ({ createOpenShellSandboxBackendFactory, createOpenShellSandboxBackendManager } =
    await import("./backend.js"));
}

export function uninstallOpenShellBackendMocks() {
  vi.doUnmock("openclaw/plugin-sdk/sandbox");
  vi.doUnmock("./cli.js");
  vi.resetModules();
}

export function resetOpenShellBackendMocks() {
  vi.clearAllMocks();
  cliMocks.createOpenShellSshSession.mockResolvedValue({
    command: "ssh",
    configPath: "/tmp/openclaw-openshell-test-ssh-config",
    host: "openshell-test",
  });
  sandboxMocks.cleanupPreparedExec.mockResolvedValue(undefined);
  sandboxMocks.prepareSshSandboxExec.mockImplementation(
    async (params: {
      session: { command: string; configPath: string; host: string };
      tty?: boolean;
    }) => ({
      argv: [
        params.session.command,
        "-F",
        params.session.configPath,
        ...(params.tty ? ["-tt", "-o", "RequestTTY=force"] : ["-T", "-o", "RequestTTY=no"]),
        params.session.host,
        "'/bin/sh' '/tmp/openclaw-synthetic-staging/run.sh'",
      ],
      cleanup: sandboxMocks.cleanupPreparedExec,
    }),
  );
  sandboxMocks.runSshSandboxCommand.mockImplementation(
    async (params: { remoteCommand: string; stdin?: Buffer | string; allowFailure?: boolean }) => {
      const remoteCommand = params.remoteCommand
        .replaceAll("'/sandbox", `'${sandboxMocks.remoteRoot}`)
        .replaceAll("'/agent", `'${sandboxMocks.remoteAgentRoot}`);
      const result = spawnSync("sh", ["-c", remoteCommand], {
        input: params.stdin,
      });
      if (result.error) {
        throw result.error;
      }
      const stdout = result.stdout ?? Buffer.alloc(0);
      const stderr = result.stderr ?? Buffer.alloc(0);
      const code = result.status ?? 1;
      if (code !== 0 && !params.allowFailure) {
        throw Object.assign(new Error(stderr.toString("utf8").trim()), { code, stdout, stderr });
      }
      return { stdout, stderr, code };
    },
  );
}

export async function finalizeMirror(backend: OpenShellSandboxBackend): Promise<void> {
  await backend.finalizeExec?.({
    status: "completed",
    exitCode: 0,
    timedOut: false,
    token: undefined,
  });
}

export async function createOpenShellBackendFixture(params: {
  workspaceDir: string;
  mode: "mirror" | "remote";
  skillsWorkspaceDir?: string;
  agentWorkspaceDir?: string;
  remoteAgentWorkspaceDir?: string;
}): Promise<OpenShellSandboxBackend> {
  const factory = createOpenShellSandboxBackendFactory({
    pluginConfig: resolveOpenShellPluginConfig({
      mode: params.mode,
      remoteAgentWorkspaceDir: params.remoteAgentWorkspaceDir || undefined,
    }),
  });
  return (await factory({
    sessionKey: "agent:main:turn",
    scopeKey: "agent:main",
    workspaceDir: params.workspaceDir,
    agentWorkspaceDir: params.agentWorkspaceDir ?? params.workspaceDir,
    ...(params.skillsWorkspaceDir ? { skillsWorkspaceDir: params.skillsWorkspaceDir } : {}),
    cfg: createOpenShellBackendSandboxConfig(),
  })) as OpenShellSandboxBackend;
}
