import {
  createSandboxBrowserConfig,
  createSandboxPruneConfig,
  createSandboxSshConfig,
  createSandboxUserConfig,
} from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { SandboxConfig } from "./types.js";

const userMocks = vi.hoisted(() => ({
  buildUserSandboxArgv: vi.fn(),
  resolveUserSandboxHome: vi.fn(),
  runUserSandboxCommand: vi.fn(),
  uploadDirectoryToUserTarget: vi.fn(),
}));

vi.mock("./user.js", async () => {
  const actual = await vi.importActual<typeof import("./user.js")>("./user.js");
  return {
    ...actual,
    buildUserSandboxArgv: userMocks.buildUserSandboxArgv,
    resolveUserSandboxHome: userMocks.resolveUserSandboxHome,
    runUserSandboxCommand: userMocks.runUserSandboxCommand,
    uploadDirectoryToUserTarget: userMocks.uploadDirectoryToUserTarget,
  };
});

const { createUserSandboxBackend, userSandboxBackendManager } = await import("./user-backend.js");

function createConfig(): OpenClawConfig {
  return {
    agents: {
      defaults: {
        sandbox: {
          mode: "all",
          backend: "user",
          scope: "session",
          workspaceAccess: "rw",
          user: {
            username: "sandbox",
            command: "su",
          },
        },
      },
    },
  };
}

function createBackendSandboxConfig(
  params: {
    binds?: string[];
    username?: string;
    workspaceAccess?: "none" | "ro" | "rw";
    workspaceDir?: string;
    workspaceRoot?: string;
  } = {},
): SandboxConfig {
  return {
    mode: "all",
    backend: "user",
    scope: "session",
    workspaceAccess: params.workspaceAccess ?? "rw",
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
      ...(params.binds ? { binds: params.binds } : {}),
    },
    ssh: createSandboxSshConfig("/remote/openclaw"),
    user: createSandboxUserConfig({
      username: params.username,
      workspaceDir: params.workspaceDir,
      workspaceRoot: params.workspaceRoot,
    }),
    browser: createSandboxBrowserConfig({
      image: "img",
      containerPrefix: "prefix-",
      cdpPort: 1,
      vncPort: 2,
      noVncPort: 3,
      autoStartTimeoutMs: 1,
    }),
    tools: { allow: [], deny: [] },
    prune: createSandboxPruneConfig(),
  };
}

async function expectBackendCreationToReject(params: {
  binds?: string[];
  username?: string;
  error: string;
}) {
  await expect(
    createUserSandboxBackend({
      sessionKey: "s",
      scopeKey: "s",
      workspaceDir: "/tmp/workspace",
      agentWorkspaceDir: "/tmp/workspace",
      cfg: createBackendSandboxConfig({
        binds: params.binds,
        username: params.username,
      }),
    }),
  ).rejects.toThrow(params.error);
}

describe("user sandbox backend", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    userMocks.resolveUserSandboxHome.mockResolvedValue("/home/sandbox");
    userMocks.runUserSandboxCommand.mockResolvedValue({
      stdout: Buffer.from("1\n"),
      stderr: Buffer.alloc(0),
      code: 0,
    });
    userMocks.uploadDirectoryToUserTarget.mockResolvedValue(undefined);
    userMocks.buildUserSandboxArgv.mockImplementation(({ settings, remoteCommand }) => [
      settings.command,
      settings.username,
      "-c",
      remoteCommand,
    ]);
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) {
        delete process.env[key];
      }
    }
    Object.assign(process.env, originalEnv);
    vi.restoreAllMocks();
  });

  it("describes runtimes via the configured user", async () => {
    const result = await userSandboxBackendManager.describeRuntime({
      entry: {
        containerName: "openclaw-user-agent-worker-abcd1234",
        backendId: "user",
        runtimeLabel: "openclaw-user-agent-worker-abcd1234",
        sessionKey: "agent:worker",
        createdAtMs: 1,
        lastUsedAtMs: 1,
        image: "sandbox",
        configLabelKind: "User",
      },
      config: createConfig(),
    });

    expect(result).toEqual({
      running: true,
      actualConfigLabel: "sandbox",
      configLabelMatch: true,
    });
    expect(userMocks.resolveUserSandboxHome).toHaveBeenCalledWith({
      command: "su",
      username: "sandbox",
    });
    expect(userMocks.runUserSandboxCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        remoteCommand: expect.stringContaining(
          "/home/sandbox/.openclaw/sandboxes/openclaw-user-agent-worker",
        ),
      }),
    );
  });

  it("removes runtimes by deleting only the per-scope runtime root", async () => {
    await userSandboxBackendManager.removeRuntime({
      entry: {
        containerName: "openclaw-user-agent-worker-abcd1234",
        backendId: "user",
        runtimeLabel: "openclaw-user-agent-worker-abcd1234",
        sessionKey: "agent:worker",
        createdAtMs: 1,
        lastUsedAtMs: 1,
        image: "sandbox",
        configLabelKind: "User",
      },
      config: createConfig(),
    });

    expect(userMocks.runUserSandboxCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        allowFailure: true,
        remoteCommand: expect.stringContaining('rm -rf -- "$1"'),
      }),
    );
    expect(userMocks.runUserSandboxCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        remoteCommand: expect.stringContaining("/home/sandbox/.openclaw/sandboxes/"),
      }),
    );
  });

  it("uses the target user's default workspace and sandbox root", async () => {
    userMocks.runUserSandboxCommand
      .mockResolvedValueOnce({
        stdout: Buffer.from("0\n"),
        stderr: Buffer.alloc(0),
        code: 0,
      })
      .mockResolvedValue({
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
        code: 0,
      });

    const backend = await createUserSandboxBackend({
      sessionKey: "agent:worker:task",
      scopeKey: "agent:worker",
      workspaceDir: "/tmp/agent",
      agentWorkspaceDir: "/tmp/agent",
      cfg: createBackendSandboxConfig({
        username: "sandbox",
        workspaceAccess: "rw",
      }),
    });

    const execSpec = await backend.buildExecSpec({
      command: "pwd",
      env: { TEST_TOKEN: "1" },
      usePty: false,
    });

    expect(backend.workdir).toBe("/home/sandbox/.openclaw/workspace");
    expect(execSpec.argv).toEqual(
      expect.arrayContaining(["su", "sandbox", "-c", expect.any(String)]),
    );
    expect(execSpec.argv.at(-1)).toContain("/home/sandbox/.openclaw/workspace");
    expect(userMocks.uploadDirectoryToUserTarget).toHaveBeenCalledTimes(1);
    expect(userMocks.uploadDirectoryToUserTarget).toHaveBeenCalledWith(
      expect.objectContaining({
        localDir: "/tmp/agent",
        targetDir: "/home/sandbox/.openclaw/workspace",
      }),
    );
  });

  it("honors custom target-user workspace paths for read-only agent access", async () => {
    userMocks.runUserSandboxCommand
      .mockResolvedValueOnce({
        stdout: Buffer.from("0\n"),
        stderr: Buffer.alloc(0),
        code: 0,
      })
      .mockResolvedValue({
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
        code: 0,
      });

    const backend = await createUserSandboxBackend({
      sessionKey: "agent:worker:task",
      scopeKey: "agent:worker",
      workspaceDir: "/tmp/sandbox-workspace",
      agentWorkspaceDir: "/tmp/agent-workspace",
      cfg: createBackendSandboxConfig({
        username: "sandbox",
        workspaceAccess: "ro",
        workspaceDir: "~/custom-workspace",
        workspaceRoot: "~/custom-sandboxes",
      }),
    });

    await backend.buildExecSpec({
      command: "pwd",
      env: {},
      usePty: false,
    });

    expect(backend.workdir).toContain("/home/sandbox/custom-sandboxes/");
    expect(backend.workdir).toContain("/workspace");
    expect(userMocks.uploadDirectoryToUserTarget).toHaveBeenCalledTimes(2);
    expect(userMocks.uploadDirectoryToUserTarget).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        localDir: "/tmp/agent-workspace",
        targetDir: "/home/sandbox/custom-workspace",
      }),
    );
  });

  it("filters blocked secrets from exec subprocess env", async () => {
    process.env.OPENAI_API_KEY = "sk-test-secret";
    process.env.LANG = "en_US.UTF-8";
    const backend = await createUserSandboxBackend({
      sessionKey: "agent:worker:task",
      scopeKey: "agent:worker",
      workspaceDir: "/tmp/workspace",
      agentWorkspaceDir: "/tmp/workspace",
      cfg: createBackendSandboxConfig({
        username: "sandbox",
      }),
    });

    const execSpec = await backend.buildExecSpec({
      command: "pwd",
      env: {},
      usePty: false,
    });

    expect(execSpec.env?.OPENAI_API_KEY).toBeUndefined();
    expect(execSpec.env?.LANG).toBe("en_US.UTF-8");
  });

  it("rejects docker binds and missing user", async () => {
    await expectBackendCreationToReject({
      binds: ["/tmp:/tmp:rw"],
      username: "sandbox",
      error: "does not support sandbox.docker.binds",
    });

    await expectBackendCreationToReject({
      error: "requires agents.defaults.sandbox.user.username",
    });
  });
});
