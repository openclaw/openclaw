// Sandbox lifecycle tests cover opt-in session-owner cleanup semantics.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveWorkspaceAttestationPaths } from "../workspace.js";
import { resolveSandboxWorkspaceDir } from "./shared.js";

const backendManagerMocks = vi.hoisted(() => ({
  describeRuntime: vi.fn(),
  removeRuntime: vi.fn(),
}));
const backendMocks = vi.hoisted(() => ({
  getSandboxBackendManager: vi.fn<() => typeof backendManagerMocks | null>(
    () => backendManagerMocks,
  ),
}));

const registryMocks = vi.hoisted(() => ({
  readBrowserRegistry: vi.fn(),
  readRegistry: vi.fn(),
  readWorkspaceRegistry: vi.fn(),
  removeBrowserRegistryEntryIfUnchanged: vi.fn(),
  removeRegistryEntryIfUnchanged: vi.fn(),
  removeWorkspaceRegistryEntryIfUnchanged: vi.fn(),
}));

const registryCleanupHelpers = vi.hoisted(() => ({
  getSandboxRegistryCleanupLocations: vi.fn(
    (entry: {
      workspaceRoot?: string;
      sshTarget?: string;
      sshWorkspaceRoot?: string;
      cleanupMetadata?: Record<string, unknown> | null;
      supersededCleanupLocations?: Array<Record<string, unknown>>;
    }) => [
      {
        workspaceRoot: entry.workspaceRoot,
        sshTarget: entry.sshTarget,
        sshWorkspaceRoot: entry.sshWorkspaceRoot,
        cleanupMetadata: entry.cleanupMetadata,
      },
      ...(entry.supersededCleanupLocations ?? []),
    ],
  ),
  applySandboxRegistryCleanupLocation: vi.fn(
    (entry: Record<string, unknown>, location: Record<string, string | null | undefined>) => ({
      ...entry,
      ...location,
    }),
  ),
  getSandboxWorkspaceRegistryRoots: vi.fn(
    (entry: { workspaceRoot: string; supersededWorkspaceRoots?: string[] }) => [
      entry.workspaceRoot,
      ...(entry.supersededWorkspaceRoots ?? []),
    ],
  ),
}));

const dockerBackendMocks = vi.hoisted(() => ({
  removeRuntime: vi.fn(),
}));

const browserBridgeMocks = vi.hoisted(() => ({
  bridges: new Map(),
  stopBrowserBridgeServer: vi.fn(),
}));

vi.mock("./backend.js", () => ({
  getSandboxBackendManager: backendMocks.getSandboxBackendManager,
}));

vi.mock("./registry.js", () => ({
  applySandboxRegistryCleanupLocation: registryCleanupHelpers.applySandboxRegistryCleanupLocation,
  getSandboxRegistryCleanupLocations: registryCleanupHelpers.getSandboxRegistryCleanupLocations,
  getSandboxWorkspaceRegistryRoots: registryCleanupHelpers.getSandboxWorkspaceRegistryRoots,
  readBrowserRegistry: registryMocks.readBrowserRegistry,
  readRegistry: registryMocks.readRegistry,
  readWorkspaceRegistry: registryMocks.readWorkspaceRegistry,
  removeBrowserRegistryEntryIfUnchanged: registryMocks.removeBrowserRegistryEntryIfUnchanged,
  removeRegistryEntryIfUnchanged: registryMocks.removeRegistryEntryIfUnchanged,
  removeWorkspaceRegistryEntryIfUnchanged: registryMocks.removeWorkspaceRegistryEntryIfUnchanged,
}));

vi.mock("./docker-backend.js", () => ({
  dockerSandboxBackendManager: dockerBackendMocks,
}));

vi.mock("./browser-bridges.js", () => ({
  BROWSER_BRIDGES: browserBridgeMocks.bridges,
}));

vi.mock("../../plugin-sdk/browser-bridge.js", () => ({
  stopBrowserBridgeServer: browserBridgeMocks.stopBrowserBridgeServer,
}));

let cleanupSessionScopedSandboxForLifecycleEnd: typeof import("./lifecycle.js").cleanupSessionScopedSandboxForLifecycleEnd;
const tmpDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-sandbox-lifecycle-"));
  tmpDirs.push(dir);
  return dir;
}

function sandboxConfig(params: {
  workspaceRoot: string;
  scope?: "session" | "agent" | "shared";
  onSessionEnd?: boolean;
}): OpenClawConfig {
  return {
    agents: {
      defaults: {
        sandbox: {
          mode: "all",
          scope: params.scope ?? "session",
          workspaceRoot: params.workspaceRoot,
          prune: {
            idleHours: 24,
            maxAgeDays: 7,
            onSessionEnd: params.onSessionEnd ?? true,
          },
        },
      },
    },
  };
}

describe("cleanupSessionScopedSandboxForLifecycleEnd", () => {
  beforeEach(async () => {
    vi.resetModules();
    backendMocks.getSandboxBackendManager.mockReset();
    backendManagerMocks.describeRuntime.mockReset();
    backendManagerMocks.removeRuntime.mockReset();
    dockerBackendMocks.removeRuntime.mockReset();
    browserBridgeMocks.bridges.clear();
    browserBridgeMocks.stopBrowserBridgeServer.mockReset();
    registryMocks.readBrowserRegistry.mockReset();
    registryMocks.readRegistry.mockReset();
    registryMocks.readWorkspaceRegistry.mockReset();
    registryMocks.removeBrowserRegistryEntryIfUnchanged.mockReset();
    registryMocks.removeRegistryEntryIfUnchanged.mockReset();
    registryMocks.removeWorkspaceRegistryEntryIfUnchanged.mockReset();
    backendMocks.getSandboxBackendManager.mockReturnValue(backendManagerMocks);
    backendManagerMocks.removeRuntime.mockResolvedValue(undefined);
    dockerBackendMocks.removeRuntime.mockResolvedValue(undefined);
    registryMocks.readBrowserRegistry.mockResolvedValue({ entries: [] });
    registryMocks.readRegistry.mockResolvedValue({ entries: [] });
    registryMocks.readWorkspaceRegistry.mockResolvedValue({ entries: [] });
    registryMocks.removeBrowserRegistryEntryIfUnchanged.mockResolvedValue(undefined);
    registryMocks.removeRegistryEntryIfUnchanged.mockResolvedValue(undefined);
    registryMocks.removeWorkspaceRegistryEntryIfUnchanged.mockResolvedValue(undefined);
    browserBridgeMocks.stopBrowserBridgeServer.mockResolvedValue(undefined);
    ({ cleanupSessionScopedSandboxForLifecycleEnd } = await import("./lifecycle.js"));
  });

  afterEach(async () => {
    for (const dir of tmpDirs.splice(0)) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("skips cleanup unless session scope and onSessionEnd are both enabled", async () => {
    const workspaceRoot = await makeTempDir();
    const agentScope = await cleanupSessionScopedSandboxForLifecycleEnd({
      config: sandboxConfig({ workspaceRoot, scope: "agent" }),
      sessionKeys: ["agent:main:task"],
      reason: "session-reset",
    });
    const disabled = await cleanupSessionScopedSandboxForLifecycleEnd({
      config: sandboxConfig({ workspaceRoot, onSessionEnd: false }),
      sessionKeys: ["agent:main:task"],
      reason: "session-delete",
    });

    expect(agentScope.skipped).toBe(true);
    expect(disabled.skipped).toBe(true);
    expect(backendMocks.getSandboxBackendManager).not.toHaveBeenCalled();
  });

  it("cleans recorded managed session resources after current config disables lifecycle cleanup", async () => {
    const workspaceRoot = await makeTempDir();
    const scopeKey = "agent:main:thread:recorded";
    const workspaceDir = resolveSandboxWorkspaceDir(workspaceRoot, scopeKey);
    await fs.mkdir(workspaceDir, { recursive: true });
    registryMocks.readRegistry.mockResolvedValue({
      entries: [
        {
          containerName: "runtime-recorded",
          backendId: "docker",
          sessionKey: scopeKey,
          createdAtMs: 1,
          lastUsedAtMs: 1,
          image: "openclaw-sandbox:test",
          scope: "session",
          workspaceRoot,
          lifecycleCleanupOnSessionEnd: true,
        },
      ],
    });

    const result = await cleanupSessionScopedSandboxForLifecycleEnd({
      config: sandboxConfig({ workspaceRoot, onSessionEnd: false }),
      sessionKeys: [scopeKey],
      reason: "session-delete",
    });

    await expect(fs.stat(workspaceDir)).rejects.toMatchObject({ code: "ENOENT" });
    expect(result.skipped).toBe(false);
    expect(result.removedContainers).toBe(1);
    expect(registryMocks.removeRegistryEntryIfUnchanged).toHaveBeenCalledWith(
      expect.objectContaining({ containerName: "runtime-recorded" }),
    );
  });

  it("keeps explicitly non-session registry rows out of lifecycle cleanup", async () => {
    const workspaceRoot = await makeTempDir();
    const scopeKey = "agent:main:thread:agent-owned";
    const workspaceDir = resolveSandboxWorkspaceDir(workspaceRoot, scopeKey);
    await fs.mkdir(workspaceDir, { recursive: true });
    registryMocks.readRegistry.mockResolvedValue({
      entries: [
        {
          containerName: "runtime-agent-owned",
          backendId: "docker",
          sessionKey: scopeKey,
          createdAtMs: 1,
          lastUsedAtMs: 1,
          image: "openclaw-sandbox:test",
          scope: "agent",
          workspaceRoot,
          lifecycleCleanupOnSessionEnd: true,
        },
      ],
    });

    const result = await cleanupSessionScopedSandboxForLifecycleEnd({
      config: sandboxConfig({ workspaceRoot }),
      sessionKeys: [scopeKey],
      reason: "session-delete",
    });

    await expect(fs.stat(workspaceDir)).resolves.toBeTruthy();
    expect(result).toEqual({
      skipped: true,
      scopeKeys: [],
      removedContainers: 0,
      removedBrowsers: 0,
      removedWorkspaces: 0,
      failures: [],
    });
    expect(backendMocks.getSandboxBackendManager).not.toHaveBeenCalled();
    expect(registryMocks.removeRegistryEntryIfUnchanged).not.toHaveBeenCalled();
  });

  it("cleans all managed scope keys for the persisted owner session id", async () => {
    const workspaceRoot = await makeTempDir();
    const peerA = "agent:main:slack:default:direct:u123";
    const peerB = "agent:main:slack:default:direct:u456";
    await fs.mkdir(resolveSandboxWorkspaceDir(workspaceRoot, peerA), { recursive: true });
    await fs.mkdir(resolveSandboxWorkspaceDir(workspaceRoot, peerB), { recursive: true });
    registryMocks.readRegistry.mockResolvedValue({
      entries: [
        {
          containerName: "runtime-peer-a",
          backendId: "docker",
          sessionKey: peerA,
          createdAtMs: 1,
          lastUsedAtMs: 1,
          image: "openclaw-sandbox:test",
          scope: "session",
          workspaceRoot,
          lifecycleCleanupOnSessionEnd: true,
          lifecycleOwnerSessionId: "session-old",
        },
        {
          containerName: "runtime-peer-b",
          backendId: "docker",
          sessionKey: peerB,
          createdAtMs: 1,
          lastUsedAtMs: 1,
          image: "openclaw-sandbox:test",
          scope: "session",
          workspaceRoot,
          lifecycleCleanupOnSessionEnd: true,
          lifecycleOwnerSessionId: "session-old",
        },
      ],
    });

    const result = await cleanupSessionScopedSandboxForLifecycleEnd({
      config: sandboxConfig({ workspaceRoot, onSessionEnd: false }),
      sessionKeys: [peerA],
      ownerSessionIds: ["session-old"],
      reason: "session-reset",
    });

    expect(result.scopeKeys).toEqual([peerA, peerB]);
    expect(result.removedContainers).toBe(2);
    expect(result.removedWorkspaces).toBe(2);
    expect(registryMocks.removeRegistryEntryIfUnchanged).toHaveBeenCalledWith(
      expect.objectContaining({ containerName: "runtime-peer-a" }),
    );
    expect(registryMocks.removeRegistryEntryIfUnchanged).toHaveBeenCalledWith(
      expect.objectContaining({ containerName: "runtime-peer-b" }),
    );
  });

  it("removes a recorded workspace-only row when runtime creation never finalized", async () => {
    const oldWorkspaceRoot = await makeTempDir();
    const workspaceRoot = await makeTempDir();
    const scopeKey = "agent:main:thread:workspace-only";
    const oldWorkspaceDir = resolveSandboxWorkspaceDir(oldWorkspaceRoot, scopeKey);
    const workspaceDir = resolveSandboxWorkspaceDir(workspaceRoot, scopeKey);
    await fs.mkdir(oldWorkspaceDir, { recursive: true });
    await fs.mkdir(workspaceDir, { recursive: true });
    const workspaceEntry = {
      containerName: "workspace-row",
      sessionKey: scopeKey,
      createdAtMs: 1,
      lastUsedAtMs: 1,
      scope: "session" as const,
      workspaceRoot,
      supersededWorkspaceRoots: [oldWorkspaceRoot],
      lifecycleCleanupOnSessionEnd: true,
      lifecycleOwnerSessionId: "session-old",
    };
    registryMocks.readWorkspaceRegistry.mockResolvedValue({
      entries: [workspaceEntry],
    });

    const result = await cleanupSessionScopedSandboxForLifecycleEnd({
      config: sandboxConfig({ workspaceRoot, onSessionEnd: false }),
      sessionKeys: [],
      ownerSessionIds: ["session-old"],
      reason: "session-delete",
    });

    await expect(fs.stat(oldWorkspaceDir)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(workspaceDir)).rejects.toMatchObject({ code: "ENOENT" });
    expect(result.removedContainers).toBe(0);
    expect(result.removedBrowsers).toBe(0);
    expect(result.removedWorkspaces).toBe(2);
    expect(backendManagerMocks.removeRuntime).not.toHaveBeenCalled();
    expect(registryMocks.removeWorkspaceRegistryEntryIfUnchanged).toHaveBeenCalledWith(
      workspaceEntry,
    );
  });

  it("restarts cleanup when the locked registry reread discovers another owner scope", async () => {
    const workspaceRoot = await makeTempDir();
    const scopeKey = "agent:main:slack:default:direct:u789";
    const workspaceDir = resolveSandboxWorkspaceDir(workspaceRoot, scopeKey);
    await fs.mkdir(workspaceDir, { recursive: true });
    const entry = {
      containerName: "runtime-discovered-owner",
      backendId: "docker",
      sessionKey: scopeKey,
      createdAtMs: 1,
      lastUsedAtMs: 1,
      image: "openclaw-sandbox:test",
      scope: "session" as const,
      workspaceRoot,
      lifecycleCleanupOnSessionEnd: true,
      lifecycleOwnerSessionId: "session-old",
    };
    registryMocks.readRegistry
      .mockResolvedValueOnce({ entries: [] })
      .mockResolvedValueOnce({ entries: [entry] })
      .mockResolvedValueOnce({ entries: [entry] });

    const result = await cleanupSessionScopedSandboxForLifecycleEnd({
      config: sandboxConfig({ workspaceRoot, onSessionEnd: false }),
      sessionKeys: [],
      ownerSessionIds: ["session-old"],
      reason: "session-rollover",
    });

    await expect(fs.stat(workspaceDir)).rejects.toMatchObject({ code: "ENOENT" });
    expect(registryMocks.readRegistry).toHaveBeenCalledTimes(3);
    expect(result.scopeKeys).toEqual([scopeKey]);
    expect(result.removedContainers).toBe(1);
    expect(result.removedWorkspaces).toBe(1);
    expect(backendManagerMocks.removeRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        entry: expect.objectContaining({ containerName: "runtime-discovered-owner" }),
      }),
    );
  });

  it("does not remove a replacement runtime owned by a newer session", async () => {
    const workspaceRoot = await makeTempDir();
    const scopeKey = "agent:main:slack:default:direct:u123";
    const workspaceDir = resolveSandboxWorkspaceDir(workspaceRoot, scopeKey);
    const warnings: string[] = [];
    await fs.mkdir(workspaceDir, { recursive: true });
    registryMocks.readRegistry.mockResolvedValue({
      entries: [
        {
          containerName: "runtime-new-owner",
          backendId: "docker",
          sessionKey: scopeKey,
          createdAtMs: 1,
          lastUsedAtMs: 1,
          image: "openclaw-sandbox:test",
          scope: "session",
          workspaceRoot,
          lifecycleCleanupOnSessionEnd: true,
          lifecycleOwnerSessionId: "session-new",
        },
      ],
    });

    const result = await cleanupSessionScopedSandboxForLifecycleEnd({
      config: sandboxConfig({ workspaceRoot, onSessionEnd: false }),
      sessionKeys: [scopeKey],
      ownerSessionIds: ["session-old"],
      reason: "session-rollover",
      onWarn: (message) => warnings.push(message),
    });

    await expect(fs.stat(workspaceDir)).resolves.toBeTruthy();
    expect(result.skipped).toBe(true);
    expect(result.scopeKeys).toEqual([]);
    expect(result.removedContainers).toBe(0);
    expect(result.removedWorkspaces).toBe(0);
    expect(result.failures).toEqual([]);
    expect(warnings).toEqual([]);
    expect(backendManagerMocks.removeRuntime).not.toHaveBeenCalled();
    expect(registryMocks.removeRegistryEntryIfUnchanged).not.toHaveBeenCalled();
  });

  it("keeps shared workspace paths when an old runtime has a replacement owner", async () => {
    const workspaceRoot = await makeTempDir();
    const scopeKey = "agent:main:slack:default:direct:u123";
    const workspaceDir = resolveSandboxWorkspaceDir(workspaceRoot, scopeKey);
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.writeFile(path.join(workspaceDir, "state.txt"), "current owner\n", "utf-8");
    registryMocks.readRegistry.mockResolvedValue({
      entries: [
        {
          containerName: "runtime-old-owner",
          backendId: "docker",
          sessionKey: scopeKey,
          createdAtMs: 1,
          lastUsedAtMs: 1,
          image: "openclaw-sandbox:test",
          scope: "session",
          workspaceRoot,
          lifecycleCleanupOnSessionEnd: true,
          lifecycleOwnerSessionId: "session-old",
        },
        {
          containerName: "runtime-new-owner",
          backendId: "docker",
          sessionKey: scopeKey,
          createdAtMs: 2,
          lastUsedAtMs: 2,
          image: "openclaw-sandbox:test",
          scope: "session",
          workspaceRoot,
          lifecycleCleanupOnSessionEnd: true,
          lifecycleOwnerSessionId: "session-new",
        },
      ],
    });

    const result = await cleanupSessionScopedSandboxForLifecycleEnd({
      config: sandboxConfig({ workspaceRoot }),
      sessionKeys: [scopeKey],
      ownerSessionIds: ["session-old"],
      reason: "session-rollover",
    });

    await expect(fs.readFile(path.join(workspaceDir, "state.txt"), "utf-8")).resolves.toBe(
      "current owner\n",
    );
    expect(result.failures).toEqual([]);
    expect(result.removedContainers).toBe(1);
    expect(result.removedWorkspaces).toBe(0);
    expect(backendManagerMocks.removeRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        entry: expect.objectContaining({ containerName: "runtime-old-owner" }),
      }),
    );
    expect(backendManagerMocks.removeRuntime).not.toHaveBeenCalledWith(
      expect.objectContaining({
        entry: expect.objectContaining({ containerName: "runtime-new-owner" }),
      }),
    );
    expect(registryMocks.removeRegistryEntryIfUnchanged).toHaveBeenCalledWith(
      expect.objectContaining({ containerName: "runtime-old-owner" }),
    );
    expect(registryMocks.removeRegistryEntryIfUnchanged).not.toHaveBeenCalledWith(
      expect.objectContaining({ containerName: "runtime-new-owner" }),
    );
  });

  it("removes matching session-owned runtimes, browser runtimes, and workspace", async () => {
    const workspaceRoot = await makeTempDir();
    const scopeKey = "opaque-thread-work";
    const workspaceDir = resolveSandboxWorkspaceDir(workspaceRoot, scopeKey);
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.writeFile(path.join(workspaceDir, "state.txt"), "ephemeral\n", "utf-8");

    registryMocks.readRegistry.mockResolvedValue({
      entries: [
        {
          containerName: "runtime-target",
          backendId: "test-managed",
          sessionKey: scopeKey,
          createdAtMs: 1,
          lastUsedAtMs: 1,
          image: "openclaw-sandbox:test",
        },
        {
          containerName: "runtime-other",
          backendId: "docker",
          sessionKey: "agent:main:other",
          createdAtMs: 1,
          lastUsedAtMs: 1,
          image: "openclaw-sandbox:test",
        },
      ],
    });
    registryMocks.readBrowserRegistry.mockResolvedValue({
      entries: [
        {
          containerName: "browser-target",
          sessionKey: scopeKey,
          createdAtMs: 1,
          lastUsedAtMs: 1,
          image: "openclaw-browser:test",
          cdpPort: 9222,
        },
      ],
    });

    const result = await cleanupSessionScopedSandboxForLifecycleEnd({
      config: sandboxConfig({ workspaceRoot }),
      agentId: "ops",
      sessionKeys: [scopeKey, scopeKey],
      reason: "session-delete",
    });

    await expect(fs.stat(workspaceDir)).rejects.toMatchObject({ code: "ENOENT" });
    expect(result).toMatchObject({
      skipped: false,
      scopeKeys: [scopeKey],
      removedContainers: 1,
      removedBrowsers: 1,
      removedWorkspaces: 1,
      failures: [],
    });
    expect(backendMocks.getSandboxBackendManager).toHaveBeenCalledWith("test-managed");
    expect(backendManagerMocks.removeRuntime).toHaveBeenCalledWith({
      entry: expect.objectContaining({
        containerName: "runtime-target",
        sessionKey: scopeKey,
      }),
      config: expect.any(Object),
      agentId: "ops",
    });
    expect(backendManagerMocks.removeRuntime).not.toHaveBeenCalledWith(
      expect.objectContaining({
        entry: expect.objectContaining({ containerName: "runtime-other" }),
      }),
    );
    expect(registryMocks.removeRegistryEntryIfUnchanged).toHaveBeenCalledWith(
      expect.objectContaining({ containerName: "runtime-target" }),
    );
    expect(registryMocks.removeRegistryEntryIfUnchanged).not.toHaveBeenCalledWith(
      expect.objectContaining({ containerName: "runtime-other" }),
    );
    expect(dockerBackendMocks.removeRuntime).toHaveBeenCalledWith({
      entry: expect.objectContaining({
        containerName: "browser-target",
        sessionKey: scopeKey,
        configLabelKind: "BrowserImage",
      }),
      config: expect.any(Object),
      agentId: "ops",
    });
    expect(registryMocks.removeBrowserRegistryEntryIfUnchanged).toHaveBeenCalledWith(
      expect.objectContaining({ containerName: "browser-target" }),
    );
  });

  it("removes managed workspace attestations with the sandbox workspace", async () => {
    const previousStateDir = process.env["OPENCLAW_STATE_DIR"];
    const workspaceRoot = await makeTempDir();
    const stateDir = await makeTempDir();
    process.env["OPENCLAW_STATE_DIR"] = stateDir;
    const scopeKey = "agent:main:thread:reset-attestation";
    const workspaceDir = resolveSandboxWorkspaceDir(workspaceRoot, scopeKey);
    await fs.mkdir(workspaceDir, { recursive: true });
    const [attestationPath] = resolveWorkspaceAttestationPaths(workspaceDir);
    if (!attestationPath) {
      throw new Error("expected sandbox workspace attestation path");
    }
    await fs.mkdir(path.dirname(attestationPath), { recursive: true });
    await fs.writeFile(
      attestationPath,
      "openclaw-workspace-attestation:v1\n2026-07-01T00:00:00.000Z\n",
      "utf-8",
    );

    try {
      const result = await cleanupSessionScopedSandboxForLifecycleEnd({
        config: sandboxConfig({ workspaceRoot }),
        sessionKeys: [scopeKey],
        reason: "session-reset",
      });

      await expect(fs.stat(workspaceDir)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.stat(attestationPath)).rejects.toMatchObject({ code: "ENOENT" });
      expect(result.removedWorkspaces).toBe(1);
      expect(result.failures).toEqual([]);
    } finally {
      if (previousStateDir === undefined) {
        delete process.env["OPENCLAW_STATE_DIR"];
      } else {
        process.env["OPENCLAW_STATE_DIR"] = previousStateDir;
      }
    }
  });

  it("keeps the workspace when runtime removal fails for that owner", async () => {
    const workspaceRoot = await makeTempDir();
    const scopeKey = "agent:main:thread:blocked";
    const workspaceDir = resolveSandboxWorkspaceDir(workspaceRoot, scopeKey);
    const warnings: string[] = [];
    await fs.mkdir(workspaceDir, { recursive: true });
    registryMocks.readRegistry.mockResolvedValue({
      entries: [
        {
          containerName: "runtime-fail",
          backendId: "docker",
          sessionKey: scopeKey,
          createdAtMs: 1,
          lastUsedAtMs: 1,
          image: "openclaw-sandbox:test",
        },
      ],
    });
    backendManagerMocks.removeRuntime.mockRejectedValueOnce(new Error("docker unavailable"));

    const result = await cleanupSessionScopedSandboxForLifecycleEnd({
      config: sandboxConfig({ workspaceRoot }),
      sessionKeys: [scopeKey],
      reason: "session-reset",
      onWarn: (message) => warnings.push(message),
    });

    await expect(fs.stat(workspaceDir)).resolves.toBeTruthy();
    expect(result.removedWorkspaces).toBe(0);
    expect(result.failures).toEqual([
      { scopeKey, containerName: "runtime-fail", error: "docker unavailable" },
    ]);
    expect(registryMocks.removeRegistryEntryIfUnchanged).not.toHaveBeenCalledWith(
      expect.objectContaining({ containerName: "runtime-fail" }),
    );
    expect(warnings[0]).toContain("runtime-fail");
  });

  it("keeps registry and workspace when the recorded backend manager is unavailable", async () => {
    const workspaceRoot = await makeTempDir();
    const scopeKey = "agent:main:thread:custom";
    const workspaceDir = resolveSandboxWorkspaceDir(workspaceRoot, scopeKey);
    await fs.mkdir(workspaceDir, { recursive: true });
    registryMocks.readRegistry.mockResolvedValue({
      entries: [
        {
          containerName: "runtime-custom",
          backendId: "custom-missing",
          sessionKey: scopeKey,
          createdAtMs: 1,
          lastUsedAtMs: 1,
          image: "openclaw-sandbox:test",
        },
      ],
    });
    backendMocks.getSandboxBackendManager.mockReturnValue(null);

    const result = await cleanupSessionScopedSandboxForLifecycleEnd({
      config: sandboxConfig({ workspaceRoot }),
      sessionKeys: [scopeKey],
      reason: "session-delete",
    });

    await expect(fs.stat(workspaceDir)).resolves.toBeTruthy();
    expect(result.removedContainers).toBe(0);
    expect(result.removedWorkspaces).toBe(0);
    expect(result.failures).toEqual([
      {
        scopeKey,
        containerName: "runtime-custom",
        error: 'Sandbox backend "custom-missing" is not registered for lifecycle cleanup.',
      },
    ]);
    expect(registryMocks.removeRegistryEntryIfUnchanged).not.toHaveBeenCalled();
  });

  it("uses the registry workspace root when config root changed before cleanup", async () => {
    const oldWorkspaceRoot = await makeTempDir();
    const newWorkspaceRoot = await makeTempDir();
    const scopeKey = "agent:main:thread:root-change";
    const oldWorkspaceDir = resolveSandboxWorkspaceDir(oldWorkspaceRoot, scopeKey);
    const newWorkspaceDir = resolveSandboxWorkspaceDir(newWorkspaceRoot, scopeKey);
    await fs.mkdir(oldWorkspaceDir, { recursive: true });
    await fs.mkdir(newWorkspaceDir, { recursive: true });
    registryMocks.readRegistry.mockResolvedValue({
      entries: [
        {
          containerName: "runtime-old-root",
          backendId: "docker",
          sessionKey: scopeKey,
          createdAtMs: 1,
          lastUsedAtMs: 1,
          image: "openclaw-sandbox:test",
          scope: "session",
          workspaceRoot: oldWorkspaceRoot,
        },
      ],
    });

    const result = await cleanupSessionScopedSandboxForLifecycleEnd({
      config: sandboxConfig({ workspaceRoot: newWorkspaceRoot }),
      sessionKeys: [scopeKey],
      reason: "session-delete",
    });

    await expect(fs.stat(oldWorkspaceDir)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(newWorkspaceDir)).resolves.toBeTruthy();
    expect(result.removedWorkspaces).toBe(1);
    expect(result.failures).toEqual([]);
    expect(registryMocks.removeRegistryEntryIfUnchanged).toHaveBeenCalledWith(
      expect.objectContaining({ containerName: "runtime-old-root" }),
    );
  });

  it("cleans superseded runtime locations and workspace roots before finalizing", async () => {
    const oldWorkspaceRoot = await makeTempDir();
    const newWorkspaceRoot = await makeTempDir();
    const scopeKey = "agent:main:thread:location-change";
    const oldWorkspaceDir = resolveSandboxWorkspaceDir(oldWorkspaceRoot, scopeKey);
    const newWorkspaceDir = resolveSandboxWorkspaceDir(newWorkspaceRoot, scopeKey);
    await fs.mkdir(oldWorkspaceDir, { recursive: true });
    await fs.mkdir(newWorkspaceDir, { recursive: true });
    registryMocks.readRegistry.mockResolvedValue({
      entries: [
        {
          containerName: "runtime-location-change",
          backendId: "ssh",
          sessionKey: scopeKey,
          createdAtMs: 1,
          lastUsedAtMs: 1,
          image: "new-host",
          scope: "session",
          workspaceRoot: newWorkspaceRoot,
          sshTarget: "new-host",
          sshWorkspaceRoot: "/new/root",
          supersededCleanupLocations: [
            {
              workspaceRoot: oldWorkspaceRoot,
              sshTarget: "old-host",
              sshWorkspaceRoot: "/old/root",
            },
          ],
        },
      ],
    });

    const result = await cleanupSessionScopedSandboxForLifecycleEnd({
      config: sandboxConfig({ workspaceRoot: newWorkspaceRoot }),
      sessionKeys: [scopeKey],
      reason: "session-delete",
    });

    await expect(fs.stat(oldWorkspaceDir)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(newWorkspaceDir)).rejects.toMatchObject({ code: "ENOENT" });
    expect(backendManagerMocks.removeRuntime).toHaveBeenCalledTimes(2);
    expect(backendManagerMocks.removeRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        entry: expect.objectContaining({ sshTarget: "new-host", sshWorkspaceRoot: "/new/root" }),
      }),
    );
    expect(backendManagerMocks.removeRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        entry: expect.objectContaining({ sshTarget: "old-host", sshWorkspaceRoot: "/old/root" }),
      }),
    );
    expect(result.removedWorkspaces).toBe(2);
    expect(registryMocks.removeRegistryEntryIfUnchanged).toHaveBeenCalledWith(
      expect.objectContaining({ containerName: "runtime-location-change" }),
    );
  });

  it("keeps retry registry entries when workspace removal fails after runtime cleanup", async () => {
    const workspaceRoot = await makeTempDir();
    const scopeKey = "agent:main:thread:workspace-fail";
    const workspaceDir = resolveSandboxWorkspaceDir(workspaceRoot, scopeKey);
    const warnings: string[] = [];
    await fs.mkdir(workspaceDir, { recursive: true });
    registryMocks.readRegistry.mockResolvedValue({
      entries: [
        {
          containerName: "runtime-target",
          backendId: "docker",
          sessionKey: scopeKey,
          createdAtMs: 1,
          lastUsedAtMs: 1,
          image: "openclaw-sandbox:test",
        },
      ],
    });
    registryMocks.readBrowserRegistry.mockResolvedValue({
      entries: [
        {
          containerName: "browser-target",
          sessionKey: scopeKey,
          createdAtMs: 1,
          lastUsedAtMs: 1,
          image: "openclaw-browser:test",
          cdpPort: 9222,
        },
      ],
    });
    const rmOriginal = fs.rm.bind(fs);
    const rmSpy = vi.spyOn(fs, "rm").mockImplementation(async (target, options) => {
      if (String(target) === workspaceDir) {
        throw Object.assign(new Error("permission denied"), { code: "EACCES" });
      }
      return await rmOriginal(target, options);
    });

    try {
      const result = await cleanupSessionScopedSandboxForLifecycleEnd({
        config: sandboxConfig({ workspaceRoot }),
        sessionKeys: [scopeKey],
        reason: "session-reset",
        onWarn: (message) => warnings.push(message),
      });

      expect(result.removedContainers).toBe(1);
      expect(result.removedBrowsers).toBe(1);
      expect(result.removedWorkspaces).toBe(0);
      expect(result.failures).toEqual([{ scopeKey, error: "permission denied" }]);
      expect(registryMocks.removeRegistryEntryIfUnchanged).not.toHaveBeenCalledWith(
        expect.objectContaining({ containerName: "runtime-target" }),
      );
      expect(registryMocks.removeBrowserRegistryEntryIfUnchanged).not.toHaveBeenCalledWith(
        expect.objectContaining({ containerName: "browser-target" }),
      );
      expect(warnings[0]).toContain(workspaceDir);
    } finally {
      rmSpy.mockRestore();
    }
  });
});
