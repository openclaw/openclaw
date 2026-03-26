import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const cliMocks = vi.hoisted(() => ({
  runOpenShellCli: vi.fn(),
}));

vi.mock("./cli.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./cli.js")>();
  return {
    ...actual,
    runOpenShellCli: cliMocks.runOpenShellCli,
  };
});

import { createOpenShellSandboxBackendManager } from "./backend.js";
import { buildSshSubprocessEnv, SAFE_ENV_KEYS } from "./backend.js";
import { resolveOpenShellPluginConfig } from "./config.js";

describe("openshell backend manager", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("checks runtime status with config override from OpenClaw config", async () => {
    cliMocks.runOpenShellCli.mockResolvedValue({
      code: 0,
      stdout: "{}",
      stderr: "",
    });

    const manager = createOpenShellSandboxBackendManager({
      pluginConfig: resolveOpenShellPluginConfig({
        command: "openshell",
        from: "openclaw",
      }),
    });

    const result = await manager.describeRuntime({
      entry: {
        containerName: "openclaw-session-1234",
        backendId: "openshell",
        runtimeLabel: "openclaw-session-1234",
        sessionKey: "agent:main",
        createdAtMs: 1,
        lastUsedAtMs: 1,
        image: "custom-source",
        configLabelKind: "Source",
      },
      config: {
        plugins: {
          entries: {
            openshell: {
              enabled: true,
              config: {
                command: "openshell",
                from: "custom-source",
              },
            },
          },
        },
      },
    });

    expect(result).toEqual({
      running: true,
      actualConfigLabel: "custom-source",
      configLabelMatch: true,
    });
    expect(cliMocks.runOpenShellCli).toHaveBeenCalledWith({
      context: expect.objectContaining({
        sandboxName: "openclaw-session-1234",
        config: expect.objectContaining({
          from: "custom-source",
        }),
      }),
      args: ["sandbox", "get", "openclaw-session-1234"],
    });
  });

  it("removes runtimes via openshell sandbox delete", async () => {
    cliMocks.runOpenShellCli.mockResolvedValue({
      code: 0,
      stdout: "",
      stderr: "",
    });

    const manager = createOpenShellSandboxBackendManager({
      pluginConfig: resolveOpenShellPluginConfig({
        command: "/usr/local/bin/openshell",
        gateway: "lab",
      }),
    });

    await manager.removeRuntime({
      entry: {
        containerName: "openclaw-session-5678",
        backendId: "openshell",
        runtimeLabel: "openclaw-session-5678",
        sessionKey: "agent:main",
        createdAtMs: 1,
        lastUsedAtMs: 1,
        image: "openclaw",
        configLabelKind: "Source",
      },
      config: {},
    });

    expect(cliMocks.runOpenShellCli).toHaveBeenCalledWith({
      context: expect.objectContaining({
        sandboxName: "openclaw-session-5678",
        config: expect.objectContaining({
          command: "/usr/local/bin/openshell",
          gateway: "lab",
        }),
      }),
      args: ["sandbox", "delete", "openclaw-session-5678"],
    });
  });
});

describe("SAFE_ENV_KEYS", () => {
  it("is a module-level ReadonlySet allocated once", () => {
    expect(SAFE_ENV_KEYS).toBeInstanceOf(Set);
    expect(SAFE_ENV_KEYS.has("PATH")).toBe(true);
    expect(SAFE_ENV_KEYS.has("HOME")).toBe(true);
    expect(SAFE_ENV_KEYS.has("SSH_AUTH_SOCK")).toBe(true);
  });
});

describe("buildSshSubprocessEnv", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    // Restore original env after each test.
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) {
        delete process.env[key];
      }
    }
    Object.assign(process.env, originalEnv);
  });

  it("forwards only safe POSIX keys", () => {
    process.env.PATH = "/usr/bin";
    process.env.HOME = "/home/test";
    process.env.USER = "testuser";
    process.env.SHELL = "/bin/bash";
    process.env.TERM = "xterm-256color";
    process.env.LANG = "en_US.UTF-8";
    process.env.TZ = "UTC";
    process.env.TMPDIR = "/tmp";
    process.env.SSH_AUTH_SOCK = "/tmp/ssh-agent.sock";
    process.env.SSH_AGENT_PID = "12345";

    const env = buildSshSubprocessEnv();

    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/home/test");
    expect(env.USER).toBe("testuser");
    expect(env.SHELL).toBe("/bin/bash");
    expect(env.TERM).toBe("xterm-256color");
    expect(env.LANG).toBe("en_US.UTF-8");
    expect(env.TZ).toBe("UTC");
    expect(env.TMPDIR).toBe("/tmp");
    expect(env.SSH_AUTH_SOCK).toBe("/tmp/ssh-agent.sock");
    expect(env.SSH_AGENT_PID).toBe("12345");
  });

  it("strips secret API keys and credentials", () => {
    process.env.ANTHROPIC_API_KEY = "sk-secret";
    process.env.OPENAI_API_KEY = "sk-openai-secret";
    process.env.FIRECRAWL_API_KEY = "fc-secret";
    process.env.AWS_SECRET_ACCESS_KEY = "aws-secret";
    process.env.DATABASE_URL = "postgres://secret";

    const env = buildSshSubprocessEnv();

    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.FIRECRAWL_API_KEY).toBeUndefined();
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(env.DATABASE_URL).toBeUndefined();
  });

  it("forwards LC_ locale variables", () => {
    process.env.LC_ALL = "en_US.UTF-8";
    process.env.LC_CTYPE = "en_US.UTF-8";
    process.env.LC_MESSAGES = "C";

    const env = buildSshSubprocessEnv();

    expect(env.LC_ALL).toBe("en_US.UTF-8");
    expect(env.LC_CTYPE).toBe("en_US.UTF-8");
    expect(env.LC_MESSAGES).toBe("C");
  });

  it("does not forward arbitrary prefixed variables", () => {
    process.env.MY_CUSTOM_VAR = "custom";
    process.env.NODE_ENV = "production";
    process.env.SECRET_TOKEN = "token";

    const env = buildSshSubprocessEnv();

    expect(env.MY_CUSTOM_VAR).toBeUndefined();
    expect(env.NODE_ENV).toBeUndefined();
    expect(env.SECRET_TOKEN).toBeUndefined();
  });
});
