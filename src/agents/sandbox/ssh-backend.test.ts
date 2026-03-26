import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { SandboxConfig } from "./types.js";

const sshMocks = vi.hoisted(() => ({
  createSshSandboxSessionFromSettings: vi.fn(),
  disposeSshSandboxSession: vi.fn(),
  runSshSandboxCommand: vi.fn(),
  uploadDirectoryToSshTarget: vi.fn(),
  buildSshSandboxArgv: vi.fn(),
}));

vi.mock("./ssh.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./ssh.js")>();
  return {
    ...actual,
    createSshSandboxSessionFromSettings: sshMocks.createSshSandboxSessionFromSettings,
    disposeSshSandboxSession: sshMocks.disposeSshSandboxSession,
    runSshSandboxCommand: sshMocks.runSshSandboxCommand,
    uploadDirectoryToSshTarget: sshMocks.uploadDirectoryToSshTarget,
    buildSshSandboxArgv: sshMocks.buildSshSandboxArgv,
  };
});

let createSshSandboxBackend: typeof import("./ssh-backend.js").createSshSandboxBackend;
let sshSandboxBackendManager: typeof import("./ssh-backend.js").sshSandboxBackendManager;

async function loadFreshSshBackendModuleForTest() {
  vi.resetModules();
  vi.doMock("./ssh.js", async (importOriginal) => {
    const actual = await importOriginal<typeof import("./ssh.js")>();
    return {
      ...actual,
      createSshSandboxSessionFromSettings: sshMocks.createSshSandboxSessionFromSettings,
      disposeSshSandboxSession: sshMocks.disposeSshSandboxSession,
      runSshSandboxCommand: sshMocks.runSshSandboxCommand,
      uploadDirectoryToSshTarget: sshMocks.uploadDirectoryToSshTarget,
      buildSshSandboxArgv: sshMocks.buildSshSandboxArgv,
    };
  });
  ({ createSshSandboxBackend, sshSandboxBackendManager } = await import("./ssh-backend.js"));
}

function createConfig(): OpenClawConfig {
  return {
    agents: {
      defaults: {
        sandbox: {
          mode: "all",
          backend: "ssh",
          scope: "session",
          workspaceAccess: "rw",
          ssh: {
            target: "peter@example.com:2222",
            command: "ssh",
            workspaceRoot: "/remote/openclaw",
            strictHostKeyChecking: true,
            updateHostKeys: true,
          },
        },
      },
    },
  };
}

function createSession() {
  return {
    command: "ssh",
    configPath: path.join(os.tmpdir(), "openclaw-test-ssh-config"),
    host: "openclaw-sandbox",
  };
}

function createBackendSandboxConfig(params?: { binds?: string[]; target?: string }): SandboxConfig {
  return {
    mode: "all",
    backend: "ssh",
    scope: "session",
    workspaceAccess: "rw" as const,
    workspaceRoot: "~/.openclaw/sandboxes",
    docker: {
      image: "img",
      containerPrefix: "prefix-",
      workdir: "/workspace",
      readOnlyRoot: true,
      tmpfs: ["/tmp"],
      network: "none",
      capDrop: ["ALL"],
      env: {},
      ...(params?.binds ? { binds: params.binds } : {}),
    },
    ssh: {
      ...(params?.target ? { target: params.target } : {}),
      command: "ssh",
      workspaceRoot: "/remote/openclaw",
      strictHostKeyChecking: true,
      updateHostKeys: true,
    },
    browser: {
      enabled: false,
      image: "img",
      containerPrefix: "prefix-",
      network: "bridge",
      cdpPort: 1,
      vncPort: 2,
      noVncPort: 3,
      headless: true,
      enableNoVnc: false,
      allowHostControl: false,
      autoStart: false,
      autoStartTimeoutMs: 1,
    },
    tools: { allow: [], deny: [] },
    prune: { idleHours: 24, maxAgeDays: 7 },
  };
}

async function expectBackendCreationToReject(params: {
  binds?: string[];
  target?: string;
  error: string;
}) {
  await expect(
    createSshSandboxBackend({
      sessionKey: "s",
      scopeKey: "s",
      workspaceDir: "/tmp/workspace",
      agentWorkspaceDir: "/tmp/workspace",
      cfg: createBackendSandboxConfig({
        binds: params.binds,
        target: params.target,
      }),
    }),
  ).rejects.toThrow(params.error);
}

describe("ssh sandbox backend", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    sshMocks.createSshSandboxSessionFromSettings.mockResolvedValue(createSession());
    sshMocks.disposeSshSandboxSession.mockResolvedValue(undefined);
    sshMocks.runSshSandboxCommand.mockResolvedValue({
      stdout: Buffer.from("1\n"),
      stderr: Buffer.alloc(0),
      code: 0,
    });
    sshMocks.uploadDirectoryToSshTarget.mockResolvedValue(undefined);
    sshMocks.buildSshSandboxArgv.mockImplementation(({ session, remoteCommand, tty }) => [
      session.command,
      "-F",
      session.configPath,
      tty ? "-tt" : "-T",
      session.host,
      remoteCommand,
    ]);
    await loadFreshSshBackendModuleForTest();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("describes runtimes via the configured ssh target", async () => {
    const result = await sshSandboxBackendManager.describeRuntime({
      entry: {
        containerName: "openclaw-ssh-worker-abcd1234",
        backendId: "ssh",
        runtimeLabel: "openclaw-ssh-worker-abcd1234",
        sessionKey: "agent:worker",
        createdAtMs: 1,
        lastUsedAtMs: 1,
        image: "peter@example.com:2222",
        configLabelKind: "Target",
      },
      config: createConfig(),
    });

    expect(result).toEqual({
      running: true,
      actualConfigLabel: "peter@example.com:2222",
      configLabelMatch: true,
    });
    expect(sshMocks.createSshSandboxSessionFromSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        target: "peter@example.com:2222",
        workspaceRoot: "/remote/openclaw",
      }),
    );
    expect(sshMocks.runSshSandboxCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        remoteCommand: expect.stringContaining("/remote/openclaw/openclaw-ssh-agent-worker"),
      }),
    );
  });

  it("removes runtimes by deleting the remote scope root", async () => {
    await sshSandboxBackendManager.removeRuntime({
      entry: {
        containerName: "openclaw-ssh-worker-abcd1234",
        backendId: "ssh",
        runtimeLabel: "openclaw-ssh-worker-abcd1234",
        sessionKey: "agent:worker",
        createdAtMs: 1,
        lastUsedAtMs: 1,
        image: "peter@example.com:2222",
        configLabelKind: "Target",
      },
      config: createConfig(),
    });

    expect(sshMocks.runSshSandboxCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        allowFailure: true,
        remoteCommand: expect.stringContaining('rm -rf -- "$1"'),
      }),
    );
  });

  it("creates a remote-canonical backend that seeds once and reuses ssh exec", async () => {
    sshMocks.runSshSandboxCommand
      .mockResolvedValueOnce({
        stdout: Buffer.from("0\n"),
        stderr: Buffer.alloc(0),
        code: 0,
      })
      .mockResolvedValueOnce({
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
        code: 0,
      })
      .mockResolvedValueOnce({
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
        code: 0,
      });

    const backend = await createSshSandboxBackend({
      sessionKey: "agent:worker:task",
      scopeKey: "agent:worker",
      workspaceDir: "/tmp/workspace",
      agentWorkspaceDir: "/tmp/agent",
      cfg: {
        mode: "all",
        backend: "ssh",
        scope: "session",
        workspaceAccess: "rw",
        workspaceRoot: "~/.openclaw/sandboxes",
        docker: {
          image: "openclaw-sandbox:bookworm-slim",
          containerPrefix: "openclaw-sbx-",
          workdir: "/workspace",
          readOnlyRoot: true,
          tmpfs: ["/tmp"],
          network: "none",
          capDrop: ["ALL"],
          env: { LANG: "C.UTF-8" },
        },
        ssh: {
          target: "peter@example.com:2222",
          command: "ssh",
          workspaceRoot: "/remote/openclaw",
          strictHostKeyChecking: true,
          updateHostKeys: true,
        },
        browser: {
          enabled: false,
          image: "openclaw-browser",
          containerPrefix: "openclaw-browser-",
          network: "bridge",
          cdpPort: 9222,
          vncPort: 5900,
          noVncPort: 6080,
          headless: true,
          enableNoVnc: false,
          allowHostControl: false,
          autoStart: false,
          autoStartTimeoutMs: 1000,
        },
        tools: { allow: [], deny: [] },
        prune: { idleHours: 24, maxAgeDays: 7 },
      },
    });

    const execSpec = await backend.buildExecSpec({
      command: "pwd",
      env: { TEST_TOKEN: "1" },
      usePty: false,
    });

    expect(execSpec.argv).toEqual(
      expect.arrayContaining(["ssh", "-F", createSession().configPath, "-T", createSession().host]),
    );
    expect(execSpec.argv.at(-1)).toContain("/remote/openclaw/openclaw-ssh-agent-worker");
    expect(sshMocks.uploadDirectoryToSshTarget).toHaveBeenCalledTimes(2);
    expect(sshMocks.uploadDirectoryToSshTarget).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        localDir: "/tmp/workspace",
        remoteDir: expect.stringContaining("/workspace"),
      }),
    );
    expect(sshMocks.uploadDirectoryToSshTarget).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        localDir: "/tmp/agent",
        remoteDir: expect.stringContaining("/agent"),
      }),
    );

    await backend.finalizeExec?.({
      status: "completed",
      exitCode: 0,
      timedOut: false,
      token: execSpec.finalizeToken,
    });
    expect(sshMocks.disposeSshSandboxSession).toHaveBeenCalled();
  });

  it("rejects docker binds and missing ssh target", async () => {
    await expectBackendCreationToReject({
      binds: ["/tmp:/tmp:rw"],
      target: "peter@example.com:22",
      error: "does not support sandbox.docker.binds",
    });

    await expectBackendCreationToReject({
      error: "requires agents.defaults.sandbox.ssh.target",
    });
  });
});
