import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { createWarnLogCapture } from "../logging/test-helpers/warn-log-capture.js";
import { closeOpenClawAgentDatabasesAsync } from "../state/openclaw-agent-db.js";
import { registerSandboxBackend } from "./sandbox/backend.js";
import { ensureSandboxWorkspaceForSession, resolveSandboxContext } from "./sandbox/context.js";
import { isSandboxProvisioningError } from "./sandbox/provisioning-error.js";
import { createBackend, sandboxConfig } from "./test-helpers/sandbox-backend-fixtures.js";

const readRegisteredSandboxRuntimeIdsMock = vi.hoisted(() => vi.fn(async () => [] as string[]));
const syncSkillsToWorkspaceMock = vi.hoisted(() =>
  vi.fn<typeof import("../skills/loading/workspace-skill-sync.runtime.js").syncWorkspaceSkills>(
    async () => [],
  ),
);
const ensureSandboxBrowserMock = vi.hoisted(() =>
  vi.fn<typeof import("./sandbox/browser.js").ensureSandboxBrowser>(async () => null),
);
const resolveNodeExecEligibilityMock = vi.hoisted(() => vi.fn(() => ({ canExec: false })));
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
// mock-isolation: Keep persistent registry state outside context provisioning tests.
vi.mock("./sandbox/registry.js", () => ({
  readRegisteredSandboxRuntimeIds: readRegisteredSandboxRuntimeIdsMock,
  updateRegistry: vi.fn(),
}));

vi.mock("./sandbox/browser.js", () => ({
  ensureSandboxBrowser: ensureSandboxBrowserMock,
}));

vi.mock("../plugin-sdk/browser-control-auth.js", () => browserControlAuthMock);

vi.mock("../plugin-sdk/browser-profiles.js", () => browserProfilesMock);

vi.mock("./exec-defaults.js", () => ({
  resolveNodeExecEligibility: resolveNodeExecEligibilityMock,
}));

vi.mock("../skills/runtime/remote.js", () => ({
  getRemoteSkillEligibility: vi.fn(() => ({ note: "test-remote" })),
}));

vi.mock("../skills/loading/workspace-skill-sync.runtime.js", () => ({
  syncWorkspaceSkills: syncSkillsToWorkspaceMock,
}));

let sandboxFixtureRoot = "";
let sandboxFixtureCount = 0;

async function createSandboxFixtureDir(prefix: string): Promise<string> {
  // Shared fixture root avoids repeated temp-dir setup across sandbox context cases.
  const dir = path.join(sandboxFixtureRoot, `${prefix}-${sandboxFixtureCount++}`);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

beforeAll(async () => {
  // openclaw-temp-dir: allow canonical suite root is drained before removal
  sandboxFixtureRoot = await fs.mkdtemp(
    path.join(await fs.realpath(os.tmpdir()), "openclaw-sandbox-context-"),
  );
});

afterAll(async () => {
  await closeOpenClawAgentDatabasesAsync(sandboxFixtureRoot);
  await fs.rm(sandboxFixtureRoot, { recursive: true, force: true });
});

describe("resolveSandboxContext", () => {
  it("bypasses the selected main session in global scope", async () => {
    const cfg: OpenClawConfig = {
      session: { scope: "global" },
      agents: {
        ownership: "explicit",
        defaults: {
          sandbox: { mode: "non-main", scope: "session" },
        },
        entries: { main: {}, other: {} },
      },
    };

    expect(
      await ensureSandboxWorkspaceForSession({
        config: cfg,
        agentId: "main",
        sessionKey: "global",
        workspaceDir: "/tmp/openclaw-test",
      }),
    ).toBeNull();
  }, 15_000);

  it("provisions and marks a required sandbox when the agent sandbox mode is off", async () => {
    const sessionKey = "agent:main:guest";
    const workspaceDir = await createSandboxFixtureDir("required-sandbox");
    const storePath = path.join(workspaceDir, "agents", "main", "sessions", "sessions.json");
    const entry = {
      sessionId: "guest-session",
      updatedAt: 1,
      sandbox: "required" as const,
      createdActor: { type: "human" as const, source: "unknown" as const, id: "guest-principal" },
    };
    await replaceSessionEntry({ sessionKey, storePath }, entry);
    const backendFactory = vi.fn(async () => ({
      id: "required-backend",
      runtimeId: "required-runtime",
      runtimeLabel: "Required Runtime",
      workdir: "/workspace",
      buildExecSpec: async () => ({
        argv: ["required-backend", "exec"],
        env: {},
        stdinMode: "pipe-closed" as const,
      }),
      runShellCommand: async () => ({
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
        code: 0,
      }),
    }));
    const restore = registerSandboxBackend("required-backend", backendFactory);
    const warnLogs = createWarnLogCapture("openclaw-required-sandbox-workspace");

    try {
      const sandbox = await resolveSandboxContext({
        config: {
          session: { store: storePath },
          agents: {
            defaults: {
              sandbox: {
                mode: "off",
                backend: "required-backend",
                scope: "shared",
                workspaceAccess: "rw",
                prune: { idleHours: 0, maxAgeDays: 0 },
              },
            },
            entries: { main: {} },
          },
        },
        sessionKey,
        workspaceDir,
      });

      expect(sandbox).toMatchObject({
        required: true,
        workspaceAccess: "ro",
      });
      expect(sandbox?.workspaceDir).not.toBe(workspaceDir);
      expect(await warnLogs.findText("workspaceAccess")).toMatch(/rw.*ro/i);
      expect(backendFactory).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: "main",
          cfg: expect.objectContaining({ scope: "agent" }),
        }),
      );
    } finally {
      warnLogs.cleanup();
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
        entries: { main: {} },
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
    syncSkillsToWorkspaceMock.mockClear();
    resolveNodeExecEligibilityMock.mockClear();
    readRegisteredSandboxRuntimeIdsMock.mockResolvedValue(["registered-runtime"]);
    const backendFactory = vi.fn(async () =>
      createBackend({
        id: "test-backend",
        runtimeId: "test-runtime",
        runtimeLabel: "Test Runtime",
        workdir: "/runtime/workspace",
      }),
    );
    const resolveWorkdir = vi.fn(() => "/runtime/workspace");
    const restore = registerSandboxBackend("test-backend", {
      factory: backendFactory,
      resolveWorkdir,
    });
    try {
      const cfg = sandboxConfig("test-backend");
      const skillsSnapshot = {
        prompt: "skills",
        skills: [{ name: "alpha" }],
        version: 42,
      };

      const result = await resolveSandboxContext({
        config: cfg,
        execOverrides: { host: "node", node: "build-node", security: "allowlist" },
        sessionKey: "agent:worker:task",
        skillsSnapshot,
        workspaceDir: "/tmp/openclaw-test",
      });

      expect(result?.backendId).toBe("test-backend");
      expect(result?.runtimeId).toBe("test-runtime");
      expect(result?.containerName).toBe("test-runtime");
      expect(result?.backend?.id).toBe("test-backend");
      expect(backendFactory).toHaveBeenCalledWith(
        expect.objectContaining({
          registeredRuntimeIds: ["registered-runtime"],
          agentId: "worker",
        }),
      );
      expect(resolveNodeExecEligibilityMock).toHaveBeenCalledWith(
        expect.objectContaining({
          execOverrides: { host: "node", node: "build-node", security: "allowlist" },
        }),
      );
      expect(syncSkillsToWorkspaceMock).toHaveBeenCalledWith(
        expect.objectContaining({ skillsSnapshot }),
      );

      const workspace = await ensureSandboxWorkspaceForSession({
        config: cfg,
        sessionKey: "agent:worker:task",
        workspaceDir: "/tmp/openclaw-test",
      });
      expect(workspace?.containerWorkdir).toBe("/runtime/workspace");
      expect(resolveWorkdir).toHaveBeenCalledWith(expect.objectContaining({ agentId: "worker" }));
    } finally {
      readRegisteredSandboxRuntimeIdsMock.mockResolvedValue([]);
      restore();
    }
  }, 15_000);

  it("passes one workspace-qualified scope key through backend and browser setup", async () => {
    ensureSandboxBrowserMock.mockClear();
    const scopeKeys: string[] = [];
    const restore = registerSandboxBackend("workspace-scope-backend", async (params) => {
      scopeKeys.push(params.scopeKey);
      return createBackend({
        id: "workspace-scope-backend",
        runtimeId: `runtime-${params.scopeKey}`,
        runtimeLabel: "Workspace Scope Runtime",
        workdir: "/workspace",
        capabilities: { browser: true },
      });
    });
    try {
      const cfg = sandboxConfig("workspace-scope-backend", {
        scope: "agent",
        browser: { enabled: true },
      });
      const firstWorkspace = await createSandboxFixtureDir("workspace-scope-a");
      const secondWorkspace = await createSandboxFixtureDir("workspace-scope-b");

      await resolveSandboxContext({
        config: cfg,
        sessionKey: "agent:poly:msteams:channel-1",
        workspaceDir: firstWorkspace,
      });
      await resolveSandboxContext({
        config: cfg,
        sessionKey: "agent:poly:msteams:channel-1",
        workspaceDir: secondWorkspace,
      });

      expect(scopeKeys).toHaveLength(2);
      expect(scopeKeys[0]).toMatch(/^agent:poly:workspace:[a-f0-9]{32}$/);
      expect(scopeKeys[1]).toMatch(/^agent:poly:workspace:[a-f0-9]{32}$/);
      expect(scopeKeys[0]).not.toBe(scopeKeys[1]);
      expect(ensureSandboxBrowserMock.mock.calls.map(([params]) => params.scopeKey)).toEqual(
        scopeKeys,
      );
      expect(ensureSandboxBrowserMock.mock.calls[0]?.[0].ssrfPolicy).toEqual({
        dangerouslyAllowPrivateNetwork: true,
      });
    } finally {
      restore();
    }
  }, 15_000);

  it("fails closed when a required sandbox cannot be provisioned with agent sandbox mode off", async () => {
    const sessionKey = "agent:main:guest";
    const workspaceDir = await createSandboxFixtureDir("required-sandbox-failure");
    const storePath = path.join(workspaceDir, "agents", "main", "sessions", "sessions.json");
    const entry = {
      sessionId: "guest-session",
      updatedAt: 1,
      sandbox: "required" as const,
      createdActor: { type: "human" as const, source: "unknown" as const, id: "guest-principal" },
    };
    await replaceSessionEntry({ sessionKey, storePath }, entry);
    const backendFailure = new Error("Required sandbox backend unavailable");
    const restore = registerSandboxBackend("required-broken-backend", async () => {
      throw backendFailure;
    });

    try {
      await expect(
        resolveSandboxContext({
          config: {
            session: { store: storePath },
            agents: {
              defaults: {
                sandbox: {
                  mode: "off",
                  backend: "required-broken-backend",
                  scope: "session",
                  workspaceAccess: "rw",
                  prune: { idleHours: 0, maxAgeDays: 0 },
                },
              },
              entries: { main: {} },
            },
          },
          sessionKey,
          workspaceDir,
        }),
      ).rejects.toMatchObject({
        code: "sandbox_provisioning",
        backendId: "required-broken-backend",
        message: "Required sandbox backend unavailable",
        cause: backendFailure,
      });
    } finally {
      restore();
    }
  }, 15_000);

  it("keeps filesystem bridge failures inside the provisioning boundary", async () => {
    const bridgeFailure = new Error("sandbox filesystem bridge failed");
    const restore = registerSandboxBackend("bridge-failure-backend", async () =>
      createBackend({
        id: "bridge-failure-backend",
        runtimeId: "bridge-failure-runtime",
        runtimeLabel: "Bridge Failure Runtime",
        workdir: "/workspace",
        createFsBridge: () => {
          throw bridgeFailure;
        },
      }),
    );
    try {
      const cfg = sandboxConfig("bridge-failure-backend");

      const error = await resolveSandboxContext({
        config: cfg,
        sessionKey: "agent:worker:bridge-failure",
        workspaceDir: await createSandboxFixtureDir("bridge-failure"),
      }).catch((caught: unknown) => caught);

      expect(isSandboxProvisioningError(error)).toBe(true);
      expect(error).toMatchObject({
        backendId: "bridge-failure-backend",
        message: "sandbox filesystem bridge failed",
        cause: bridgeFailure,
      });
    } finally {
      restore();
    }
  }, 15_000);

  it("uses Podman directly when the Podman backend is configured", async () => {
    const backendFactory = vi.fn(async () =>
      createBackend({
        id: "podman",
        runtimeId: "podman-runtime",
        runtimeLabel: "Podman Runtime",
        workdir: "/workspace",
      }),
    );
    const restore = registerSandboxBackend("podman", backendFactory);
    try {
      const cfg = sandboxConfig("podman");

      const result = await resolveSandboxContext({
        config: cfg,
        sessionKey: "agent:worker:podman",
        workspaceDir: "/tmp/openclaw-test",
      });

      expect(result?.backendId).toBe("podman");
      const workspaceStat = await fs.stat("/tmp/openclaw-test");
      const expectedUser =
        workspaceStat.uid === 0 || workspaceStat.gid === 0
          ? undefined
          : `${workspaceStat.uid}:${workspaceStat.gid}`;
      expect(backendFactory).toHaveBeenCalledWith(
        expect.objectContaining({
          cfg: expect.objectContaining({
            backend: "podman",
            docker: expect.objectContaining({
              user: expectedUser,
            }),
          }),
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
    const skillUsagePaths = [
      {
        readPath: path.join(bundledDir, "sandboxes", "skills", "demo", "SKILL.md"),
        skillFile: path.join(workspaceDir, "skills", "demo", "SKILL.md"),
        skillName: "demo",
        skillSource: "workspace" as const,
      },
    ];
    syncSkillsToWorkspaceMock.mockResolvedValueOnce(skillUsagePaths);

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

    if (!result) {
      throw new Error("expected sandbox workspace resolution");
    }
    expect(typeof result.workspaceDir).toBe("string");
    const [syncOptions] = syncSkillsToWorkspaceMock.mock.calls[0] ?? [];
    expect(syncOptions?.sourceWorkspaceDir).toBe(workspaceDir);
    expect(syncOptions?.targetWorkspaceDir).toBe(result.workspaceDir);
    expect(syncOptions?.config).toBe(cfg);
    expect(syncOptions?.agentId).toBe("main");
    expect(syncOptions?.eligibility).toEqual({
      nodeSkills: { canExec: false },
      remote: { note: "test-remote" },
    });
    expect(result.skillUsagePaths).toEqual(skillUsagePaths);
  }, 15_000);

  it("uses the SSH backend remote workspace for sandbox workspace info", async () => {
    syncSkillsToWorkspaceMock.mockClear();
    const workspaceDir = await createSandboxFixtureDir("ssh-workspace");
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          sandbox: {
            mode: "all",
            backend: "ssh",
            scope: "session",
            workspaceAccess: "rw",
            ssh: {
              target: "ssh.example.test",
              workspaceRoot: "/remote/openclaw",
            },
          },
        },
      },
    };

    const result = await ensureSandboxWorkspaceForSession({
      config: cfg,
      sessionKey: "agent:main:main",
      workspaceDir,
    });

    expect(result?.workspaceDir).toBe(workspaceDir);
    expect(result?.containerWorkdir).toMatch(
      /^\/remote\/openclaw\/openclaw-ssh-workspace-[a-f0-9]{32}\/workspace$/,
    );
    expect(result?.containerWorkdir).not.toBe("/workspace");
    expect(result?.skillsWorkspaceDir).toContain(
      path.join(".openclaw", "sandbox", "skills-workspaces"),
    );
  }, 15_000);

  it("materializes skills for shared writable sandboxes even when roots match", async () => {
    syncSkillsToWorkspaceMock.mockClear();
    const workspaceDir = await createSandboxFixtureDir("shared-workspace");
    const userOwnedSandboxSkillsDir = path.join(
      workspaceDir,
      ".openclaw",
      "sandbox-skills",
      "skills",
      "user-owned",
    );
    await fs.mkdir(userOwnedSandboxSkillsDir, { recursive: true });
    await fs.writeFile(path.join(userOwnedSandboxSkillsDir, "SKILL.md"), "# User owned\n");

    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          sandbox: {
            mode: "all",
            scope: "shared",
            workspaceAccess: "rw",
            workspaceRoot: workspaceDir,
          },
        },
      },
    };

    const result = await ensureSandboxWorkspaceForSession({
      config: cfg,
      sessionKey: "agent:main:main",
      workspaceDir,
    });

    expect(result?.workspaceDir).toBe(workspaceDir);
    const [syncOptions] = syncSkillsToWorkspaceMock.mock.calls[0] ?? [];
    expect(syncOptions?.sourceWorkspaceDir).toBe(workspaceDir);
    expect(syncOptions?.targetWorkspaceDir).toContain(
      path.join(".openclaw", "sandbox", "skills-workspaces"),
    );
    expect(syncOptions?.targetWorkspaceDir).toMatch(
      /[\\/]shared-[a-f0-9]{8}[\\/]\.openclaw[\\/]sandbox-skills$/,
    );
    expect(syncOptions?.targetWorkspaceDir).not.toBe(
      path.join(workspaceDir, ".openclaw", "sandbox-skills"),
    );
    await expect(
      fs.readFile(path.join(userOwnedSandboxSkillsDir, "SKILL.md"), "utf8"),
    ).resolves.toBe("# User owned\n");
  }, 15_000);
});
