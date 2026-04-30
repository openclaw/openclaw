import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { registerSandboxBackend } from "./sandbox/backend.js";
import { ensureSandboxWorkspaceForSession, resolveSandboxContext } from "./sandbox/context.js";

const updateRegistryMock = vi.hoisted(() => vi.fn());
const syncSkillsToWorkspaceMock = vi.hoisted(() => vi.fn(async () => undefined));
const ensureSandboxBrowserMock = vi.hoisted(() => vi.fn(async () => null));
const removeSandboxContainerMock = vi.hoisted(() => vi.fn(async () => undefined));
const removeSandboxBrowserContainerMock = vi.hoisted(() => vi.fn(async () => undefined));
const browserControlAuthMock = vi.hoisted(() => ({
  ensureBrowserControlAuth: vi.fn(async () => ({ auth: { token: "test-browser-token" } })),
  resolveBrowserControlAuth: vi.fn(() => ({ token: "test-browser-token" })),
}));
const browserProfilesMock = vi.hoisted(() => ({
  DEFAULT_BROWSER_EVALUATE_ENABLED: true,
  resolveBrowserConfig: vi.fn(() => ({
    evaluateEnabled: true,
    ssrfPolicy: { dangerouslyAllowPrivateNetwork: true },
  })),
}));

vi.mock("./sandbox/registry.js", () => ({
  updateRegistry: updateRegistryMock,
}));

vi.mock("./sandbox/browser.js", () => ({
  ensureSandboxBrowser: ensureSandboxBrowserMock,
  resolveSandboxBrowserContainerName: vi.fn(({ cfg, scopeKey }) =>
    `${cfg.browser.containerPrefix}${scopeKey.replace(/[^a-zA-Z0-9_.-]/g, "-")}`.slice(0, 63),
  ),
}));

vi.mock("./sandbox/manage.js", () => ({
  removeSandboxContainer: removeSandboxContainerMock,
  removeSandboxBrowserContainer: removeSandboxBrowserContainerMock,
}));

vi.mock("../plugin-sdk/browser-control-auth.js", () => browserControlAuthMock);

vi.mock("../plugin-sdk/browser-profiles.js", () => browserProfilesMock);

vi.mock("../infra/skills-remote.js", () => ({
  getRemoteSkillEligibility: vi.fn(() => ({ note: "test-remote" })),
}));

vi.mock("./exec-defaults.js", () => ({
  canExecRequestNode: vi.fn(() => false),
}));

vi.mock("./skills.js", () => ({
  syncSkillsToWorkspace: syncSkillsToWorkspaceMock,
}));

let sandboxFixtureRoot = "";
let sandboxFixtureCount = 0;

async function createSandboxFixtureDir(prefix: string): Promise<string> {
  const dir = path.join(sandboxFixtureRoot, `${prefix}-${sandboxFixtureCount++}`);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

beforeAll(async () => {
  sandboxFixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-sandbox-context-"));
});

afterAll(async () => {
  await fs.rm(sandboxFixtureRoot, { recursive: true, force: true });
});

describe("resolveSandboxContext", () => {
  it("does not sandbox the agent main session in non-main mode", async () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          sandbox: { mode: "non-main", scope: "session" },
        },
        list: [{ id: "main" }],
      },
    };

    const result = await resolveSandboxContext({
      config: cfg,
      sessionKey: "agent:main:main",
      workspaceDir: "/tmp/openclaw-test",
    });

    expect(result).toBeNull();
  }, 15_000);

  it("does not create a sandbox workspace for the agent main session in non-main mode", async () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          sandbox: { mode: "non-main", scope: "session" },
        },
        list: [{ id: "main" }],
      },
    };

    const result = await ensureSandboxWorkspaceForSession({
      config: cfg,
      sessionKey: "agent:main:main",
      workspaceDir: "/tmp/openclaw-test",
    });

    expect(result).toBeNull();
  }, 15_000);

  it("does not touch sandbox backends for cron or sub-agent sessions when sandbox mode is off", async () => {
    const backendFactory = vi.fn(async () => ({
      id: "test-off-backend",
      runtimeId: "unexpected-runtime",
      runtimeLabel: "Unexpected Runtime",
      workdir: "/workspace",
      buildExecSpec: async () => ({
        argv: ["unexpected"],
        env: process.env,
        stdinMode: "pipe-closed" as const,
      }),
      runShellCommand: async () => ({
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
        code: 0,
      }),
    }));
    const restore = registerSandboxBackend("test-off-backend", backendFactory);
    try {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            sandbox: {
              mode: "off",
              backend: "test-off-backend",
              scope: "session",
            },
          },
        },
      };

      await expect(
        resolveSandboxContext({
          config: cfg,
          sessionKey: "agent:main:cron:job:run:uuid",
          workspaceDir: "/tmp/openclaw-test",
        }),
      ).resolves.toBeNull();
      await expect(
        resolveSandboxContext({
          config: cfg,
          sessionKey: "agent:main:subagent:child",
          workspaceDir: "/tmp/openclaw-test",
        }),
      ).resolves.toBeNull();

      expect(backendFactory).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  }, 15_000);

  it("treats main session aliases as main in non-main mode", async () => {
    const cfg: OpenClawConfig = {
      session: { mainKey: "work" },
      agents: {
        defaults: {
          sandbox: { mode: "non-main", scope: "session" },
        },
        list: [{ id: "main" }],
      },
    };

    expect(
      await resolveSandboxContext({
        config: cfg,
        sessionKey: "main",
        workspaceDir: "/tmp/openclaw-test",
      }),
    ).toBeNull();

    expect(
      await resolveSandboxContext({
        config: cfg,
        sessionKey: "agent:main:main",
        workspaceDir: "/tmp/openclaw-test",
      }),
    ).toBeNull();

    expect(
      await ensureSandboxWorkspaceForSession({
        config: cfg,
        sessionKey: "work",
        workspaceDir: "/tmp/openclaw-test",
      }),
    ).toBeNull();

    expect(
      await ensureSandboxWorkspaceForSession({
        config: cfg,
        sessionKey: "agent:main:main",
        workspaceDir: "/tmp/openclaw-test",
      }),
    ).toBeNull();
  }, 15_000);

  it("resolves a registered non-docker backend", async () => {
    const restore = registerSandboxBackend("test-backend", async () => ({
      id: "test-backend",
      runtimeId: "test-runtime",
      runtimeLabel: "Test Runtime",
      workdir: "/workspace",
      buildExecSpec: async () => ({
        argv: ["test-backend", "exec"],
        env: process.env,
        stdinMode: "pipe-closed",
      }),
      runShellCommand: async () => ({
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
        code: 0,
      }),
    }));
    try {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            sandbox: {
              mode: "all",
              backend: "test-backend",
              scope: "session",
              workspaceAccess: "rw",
              prune: { idleHours: 0, maxAgeDays: 0 },
            },
          },
        },
      };

      const result = await resolveSandboxContext({
        config: cfg,
        sessionKey: "agent:worker:task",
        workspaceDir: "/tmp/openclaw-test",
      });

      expect(result?.backendId).toBe("test-backend");
      expect(result?.runtimeId).toBe("test-runtime");
      expect(result?.containerName).toBe("test-runtime");
      expect(result?.backend?.id).toBe("test-backend");
    } finally {
      restore();
    }
  }, 15_000);

  it("passes the resolved browser SSRF policy to sandbox browser setup", async () => {
    ensureSandboxBrowserMock.mockClear();
    const restore = registerSandboxBackend("test-browser-backend", async () => ({
      id: "test-browser-backend",
      runtimeId: "test-browser-runtime",
      runtimeLabel: "Test Browser Runtime",
      workdir: "/workspace",
      capabilities: { browser: true },
      buildExecSpec: async () => ({
        argv: ["test-browser-backend", "exec"],
        env: process.env,
        stdinMode: "pipe-closed",
      }),
      runShellCommand: async () => ({
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
        code: 0,
      }),
    }));
    try {
      const cfg: OpenClawConfig = {
        browser: {
          ssrfPolicy: { dangerouslyAllowPrivateNetwork: true },
        },
        agents: {
          defaults: {
            sandbox: {
              mode: "all",
              backend: "test-browser-backend",
              scope: "session",
              workspaceAccess: "rw",
              prune: { idleHours: 0, maxAgeDays: 0 },
              browser: { enabled: true },
            },
          },
        },
      };

      await resolveSandboxContext({
        config: cfg,
        sessionKey: "agent:worker:browser",
        workspaceDir: "/tmp/openclaw-test",
      });

      expect(ensureSandboxBrowserMock).toHaveBeenCalledWith(
        expect.objectContaining({
          ssrfPolicy: { dangerouslyAllowPrivateNetwork: true },
        }),
      );
    } finally {
      restore();
    }
  }, 15_000);

  it("requests skill sync for read-only sandbox workspaces", async () => {
    syncSkillsToWorkspaceMock.mockClear();
    const bundledDir = await createSandboxFixtureDir("bundled");
    const workspaceDir = await createSandboxFixtureDir("workspace");

    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          sandbox: {
            mode: "all",
            scope: "session",
            workspaceAccess: "ro",
            workspaceRoot: path.join(bundledDir, "sandboxes"),
          },
        },
      },
    };

    const result = await ensureSandboxWorkspaceForSession({
      config: cfg,
      sessionKey: "agent:main:main",
      workspaceDir,
    });

    expect(result).not.toBeNull();
    expect(syncSkillsToWorkspaceMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceWorkspaceDir: workspaceDir,
        targetWorkspaceDir: result?.workspaceDir,
        config: cfg,
        agentId: "main",
        eligibility: { remote: { note: "test-remote" } },
      }),
    );
  }, 15_000);

  it("creates and cleans an ephemeral sandbox workspace for a run", async () => {
    removeSandboxContainerMock.mockClear();
    removeSandboxBrowserContainerMock.mockClear();

    const workspaceRoot = await createSandboxFixtureDir("ephemeral-root");
    const hostWorkspace = await createSandboxFixtureDir("host-workspace");
    let receivedScopeKey = "";
    const restore = registerSandboxBackend("test-ephemeral-backend", async (params) => {
      receivedScopeKey = params.scopeKey;
      return {
        id: "test-ephemeral-backend",
        runtimeId: `runtime-${params.scopeKey}`,
        runtimeLabel: "Test Ephemeral Runtime",
        workdir: "/workspace",
        buildExecSpec: async () => ({
          argv: ["test-ephemeral-backend", "exec"],
          env: process.env,
          stdinMode: "pipe-closed",
        }),
        runShellCommand: async () => ({
          stdout: Buffer.alloc(0),
          stderr: Buffer.alloc(0),
          code: 0,
        }),
      };
    });
    try {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            sandbox: {
              mode: "all",
              backend: "test-ephemeral-backend",
              scope: "session",
              workspaceAccess: "none",
              workspaceLifecycle: "ephemeral",
              workspaceRoot,
              prune: { idleHours: 0, maxAgeDays: 0 },
            },
          },
        },
      };

      const result = await resolveSandboxContext({
        config: cfg,
        runId: "run-123",
        sessionKey: "agent:worker:task",
        workspaceDir: hostWorkspace,
      });

      expect(result).not.toBeNull();
      expect(receivedScopeKey).toContain("agent:worker:task:run:run-123");
      expect(result?.workspaceDir).toContain("run-123");
      expect(result?.workspaceDir).not.toBe(hostWorkspace);
      await fs.writeFile(path.join(result!.workspaceDir, "ephemeral.txt"), "temp");

      await result?.cleanup?.();

      expect(removeSandboxContainerMock).toHaveBeenCalledWith(
        result?.runtimeId,
        expect.objectContaining({
          fallbackBackendId: "test-ephemeral-backend",
          forceUnregistered: true,
        }),
      );
      expect(removeSandboxBrowserContainerMock).not.toHaveBeenCalled();
      await expect(fs.access(result!.workspaceDir)).rejects.toThrow();
    } finally {
      restore();
    }
  }, 15_000);

  it("cleans an ephemeral workspace if backend setup fails", async () => {
    const workspaceRoot = await createSandboxFixtureDir("ephemeral-fail-root");
    const hostWorkspace = await createSandboxFixtureDir("ephemeral-fail-host");
    const restore = registerSandboxBackend("test-ephemeral-fail-backend", async () => {
      throw new Error("backend setup failed");
    });
    try {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            sandbox: {
              mode: "all",
              backend: "test-ephemeral-fail-backend",
              scope: "session",
              workspaceAccess: "none",
              workspaceLifecycle: "ephemeral",
              workspaceRoot,
              prune: { idleHours: 0, maxAgeDays: 0 },
            },
          },
        },
      };

      await expect(
        resolveSandboxContext({
          config: cfg,
          runId: "run-fail",
          sessionKey: "agent:worker:task",
          workspaceDir: hostWorkspace,
        }),
      ).rejects.toThrow("backend setup failed");

      expect(await fs.readdir(workspaceRoot)).toEqual([]);
    } finally {
      restore();
    }
  }, 15_000);

  it("pre-registers browser cleanup before ephemeral browser setup can fail", async () => {
    ensureSandboxBrowserMock.mockRejectedValueOnce(new Error("browser setup failed"));
    removeSandboxContainerMock.mockClear();
    removeSandboxBrowserContainerMock.mockClear();

    const workspaceRoot = await createSandboxFixtureDir("ephemeral-browser-root");
    const hostWorkspace = await createSandboxFixtureDir("ephemeral-browser-host");
    const restore = registerSandboxBackend("test-ephemeral-browser-backend", async (params) => ({
      id: "test-ephemeral-browser-backend",
      runtimeId: `runtime-${params.scopeKey}`,
      runtimeLabel: "Test Ephemeral Browser Runtime",
      workdir: "/workspace",
      capabilities: { browser: true },
      buildExecSpec: async () => ({
        argv: ["test-ephemeral-browser-backend", "exec"],
        env: process.env,
        stdinMode: "pipe-closed",
      }),
      runShellCommand: async () => ({
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
        code: 0,
      }),
    }));
    try {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            sandbox: {
              mode: "all",
              backend: "test-ephemeral-browser-backend",
              scope: "session",
              workspaceAccess: "none",
              workspaceLifecycle: "ephemeral",
              workspaceRoot,
              prune: { idleHours: 0, maxAgeDays: 0 },
              browser: { enabled: true },
            },
          },
        },
      };

      await expect(
        resolveSandboxContext({
          config: cfg,
          runId: "run-browser",
          sessionKey: "agent:worker:browser",
          workspaceDir: hostWorkspace,
        }),
      ).rejects.toThrow("browser setup failed");

      expect(removeSandboxBrowserContainerMock).toHaveBeenCalledWith(
        expect.stringContaining("agent-worker-browser-run-run-browser"),
        expect.objectContaining({
          forceUnregistered: true,
        }),
      );
      expect(removeSandboxContainerMock).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          fallbackBackendId: "test-ephemeral-browser-backend",
          forceUnregistered: true,
        }),
      );
      expect(await fs.readdir(workspaceRoot)).toEqual([]);
    } finally {
      restore();
    }
  }, 15_000);
});
