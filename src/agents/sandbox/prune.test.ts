// Sandbox prune tests cover runtime removal ordering and registry cleanup
// behavior for stale sandbox entries.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SandboxConfig } from "./types.js";

let maybePruneSandboxes: typeof import("./prune.js").maybePruneSandboxes;

const configMocks = vi.hoisted(() => ({
  getRuntimeConfig: vi.fn(),
}));

const backendMocks = vi.hoisted(() => ({
  removeRuntime: vi.fn(),
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

const runtimeMocks = vi.hoisted(() => ({
  error: vi.fn(),
}));

const workspaceMocks = vi.hoisted(() => ({
  removeSandboxWorkspacesForScopeKeys: vi.fn(),
}));

vi.mock("../../config/config.js", () => ({
  getRuntimeConfig: configMocks.getRuntimeConfig,
}));

vi.mock("../../runtime.js", () => ({
  defaultRuntime: runtimeMocks,
}));

vi.mock("./backend.js", () => ({
  getSandboxBackendManager: vi.fn(() => backendMocks),
}));

vi.mock("./browser-bridges.js", () => ({
  BROWSER_BRIDGES: new Map(),
}));

vi.mock("./docker-backend.js", () => ({
  dockerSandboxBackendManager: backendMocks,
}));

vi.mock("./lifecycle.js", () => ({
  removeSandboxWorkspacesForScopeKeys: workspaceMocks.removeSandboxWorkspacesForScopeKeys,
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

vi.mock("../../plugin-sdk/browser-bridge.js", () => ({
  stopBrowserBridgeServer: vi.fn(),
}));

function buildPruneConfig(): SandboxConfig {
  return {
    mode: "all",
    backend: "docker",
    scope: "session",
    workspaceAccess: "none",
    workspaceRoot: "/tmp/openclaw-sandboxes",
    docker: {
      image: "openclaw-sandbox:bookworm-slim",
      containerPrefix: "openclaw-sbx-",
      workdir: "/workspace",
      readOnlyRoot: true,
      tmpfs: [],
      network: "none",
      capDrop: ["ALL"],
      env: {},
    },
    ssh: {
      command: "ssh",
      workspaceRoot: "/tmp/openclaw-sandboxes",
      strictHostKeyChecking: true,
      updateHostKeys: true,
    },
    browser: {
      enabled: true,
      image: "openclaw-sandbox-browser:bookworm-slim",
      containerPrefix: "openclaw-sbx-browser-",
      network: "none",
      cdpPort: 9222,
      vncPort: 5900,
      noVncPort: 6080,
      headless: true,
      enableNoVnc: false,
      allowHostControl: false,
      autoStart: true,
      autoStartTimeoutMs: 1_000,
    },
    tools: {
      allow: [],
      deny: [],
    },
    prune: {
      idleHours: 1,
      maxAgeDays: 0,
      onSessionEnd: false,
    },
  };
}

function buildRuntimeConfig(params: { slowAgentIdleHours?: number } = {}) {
  const sandbox = buildPruneConfig();
  return {
    agents: {
      defaults: {
        sandbox: {
          mode: sandbox.mode,
          scope: sandbox.scope,
          workspaceRoot: sandbox.workspaceRoot,
          prune: sandbox.prune,
        },
      },
      list:
        params.slowAgentIdleHours === undefined
          ? []
          : [
              {
                id: "slow",
                sandbox: {
                  mode: sandbox.mode,
                  scope: sandbox.scope,
                  workspaceRoot: sandbox.workspaceRoot,
                  prune: {
                    ...sandbox.prune,
                    idleHours: params.slowAgentIdleHours,
                  },
                },
              },
            ],
    },
  };
}

function staleContainerEntry(overrides: Record<string, unknown> = {}) {
  return {
    containerName: "sandbox-1",
    backendId: "docker",
    sessionKey: "agent:main:thread-1",
    createdAtMs: Date.now() - 4 * 60 * 60 * 1000,
    lastUsedAtMs: Date.now() - 2 * 60 * 60 * 1000,
    image: "openclaw-sandbox:bookworm-slim",
    ...overrides,
  };
}

function staleBrowserEntry(overrides: Record<string, unknown> = {}) {
  return {
    containerName: "browser-1",
    sessionKey: "agent:main:thread-1",
    createdAtMs: Date.now() - 4 * 60 * 60 * 1000,
    lastUsedAtMs: Date.now() - 2 * 60 * 60 * 1000,
    image: "openclaw-sandbox-browser:bookworm-slim",
    cdpPort: 9222,
    ...overrides,
  };
}

describe("maybePruneSandboxes", () => {
  beforeEach(async () => {
    vi.resetModules();
    configMocks.getRuntimeConfig.mockReset();
    backendMocks.removeRuntime.mockReset();
    registryMocks.readBrowserRegistry.mockReset();
    registryMocks.readRegistry.mockReset();
    registryMocks.readWorkspaceRegistry.mockReset();
    registryMocks.removeBrowserRegistryEntryIfUnchanged.mockReset();
    registryMocks.removeRegistryEntryIfUnchanged.mockReset();
    registryMocks.removeWorkspaceRegistryEntryIfUnchanged.mockReset();
    runtimeMocks.error.mockReset();
    workspaceMocks.removeSandboxWorkspacesForScopeKeys.mockReset();

    configMocks.getRuntimeConfig.mockReturnValue(buildRuntimeConfig());
    registryMocks.readBrowserRegistry.mockResolvedValue({ entries: [] });
    registryMocks.readWorkspaceRegistry.mockResolvedValue({ entries: [] });
    registryMocks.readRegistry.mockResolvedValue({
      entries: [staleContainerEntry()],
    });
    backendMocks.removeRuntime.mockResolvedValue(undefined);
    registryMocks.removeBrowserRegistryEntryIfUnchanged.mockResolvedValue(true);
    registryMocks.removeRegistryEntryIfUnchanged.mockResolvedValue(true);
    registryMocks.removeWorkspaceRegistryEntryIfUnchanged.mockResolvedValue(true);
    workspaceMocks.removeSandboxWorkspacesForScopeKeys.mockResolvedValue({
      removedWorkspaces: 0,
      failures: [],
    });
    ({ maybePruneSandboxes } = await import("./prune.js"));
  });

  it("removes the registry entry after runtime removal succeeds", async () => {
    await maybePruneSandboxes(buildPruneConfig());

    expect(backendMocks.removeRuntime).toHaveBeenCalledTimes(1);
    expect(registryMocks.removeRegistryEntryIfUnchanged).toHaveBeenCalledWith(
      expect.objectContaining({ containerName: "sandbox-1" }),
    );
  });

  it("removes the stale runtime row before pruning session-scope workspaces", async () => {
    const order: string[] = [];
    registryMocks.readRegistry.mockResolvedValue({
      entries: [
        staleContainerEntry({
          scope: "session",
          workspaceRoot: "/tmp/openclaw-sandboxes",
          lifecycleCleanupOnSessionEnd: true,
        }),
      ],
    });
    backendMocks.removeRuntime.mockImplementationOnce(async () => {
      order.push("runtime");
    });
    workspaceMocks.removeSandboxWorkspacesForScopeKeys.mockImplementationOnce(async () => {
      order.push("workspace");
      return { removedWorkspaces: 1, failures: [] };
    });
    registryMocks.removeRegistryEntryIfUnchanged.mockImplementationOnce(async () => {
      order.push("registry");
      return true;
    });

    await maybePruneSandboxes(buildPruneConfig());

    expect(workspaceMocks.removeSandboxWorkspacesForScopeKeys).toHaveBeenCalledWith({
      workspaceRoot: "/tmp/openclaw-sandboxes",
      scopeKeys: ["agent:main:thread-1"],
    });
    expect(order).toEqual(["runtime", "registry", "workspace"]);
  });

  it("prunes superseded runtime locations and workspace roots before finalizing", async () => {
    const order: string[] = [];
    registryMocks.readRegistry.mockResolvedValue({
      entries: [
        staleContainerEntry({
          backendId: "ssh",
          scope: "session",
          workspaceRoot: "/tmp/openclaw-sandboxes-new",
          lifecycleCleanupOnSessionEnd: true,
          sshTarget: "new-host",
          sshWorkspaceRoot: "/new/root",
          supersededCleanupLocations: [
            {
              workspaceRoot: "/tmp/openclaw-sandboxes-old",
              sshTarget: "old-host",
              sshWorkspaceRoot: "/old/root",
            },
          ],
        }),
      ],
    });
    backendMocks.removeRuntime.mockImplementation(async () => {
      order.push("runtime");
    });
    workspaceMocks.removeSandboxWorkspacesForScopeKeys.mockImplementation(async () => {
      order.push("workspace");
      return { removedWorkspaces: 1, failures: [] };
    });
    registryMocks.removeRegistryEntryIfUnchanged.mockImplementationOnce(async () => {
      order.push("registry");
      return true;
    });

    await maybePruneSandboxes(buildPruneConfig());

    expect(backendMocks.removeRuntime).toHaveBeenCalledTimes(2);
    expect(backendMocks.removeRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        entry: expect.objectContaining({ sshTarget: "new-host", sshWorkspaceRoot: "/new/root" }),
      }),
    );
    expect(backendMocks.removeRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        entry: expect.objectContaining({ sshTarget: "old-host", sshWorkspaceRoot: "/old/root" }),
      }),
    );
    expect(workspaceMocks.removeSandboxWorkspacesForScopeKeys).toHaveBeenCalledWith({
      workspaceRoot: "/tmp/openclaw-sandboxes-new",
      scopeKeys: ["agent:main:thread-1"],
    });
    expect(workspaceMocks.removeSandboxWorkspacesForScopeKeys).toHaveBeenCalledWith({
      workspaceRoot: "/tmp/openclaw-sandboxes-old",
      scopeKeys: ["agent:main:thread-1"],
    });
    expect(order).toEqual(["runtime", "runtime", "registry", "workspace", "workspace"]);
  });

  it("does not finalize a session workspace when the registry row was refreshed", async () => {
    const stale = staleContainerEntry({
      scope: "session",
      workspaceRoot: "/tmp/openclaw-sandboxes",
      lifecycleCleanupOnSessionEnd: true,
      lastUsedAtMs: Date.now() - 2 * 60 * 60 * 1000,
    });
    const refreshed = {
      ...stale,
      lastUsedAtMs: Date.now(),
    };
    registryMocks.readRegistry
      .mockResolvedValueOnce({ entries: [stale] })
      .mockResolvedValueOnce({ entries: [refreshed] });

    await maybePruneSandboxes(buildPruneConfig());

    expect(workspaceMocks.removeSandboxWorkspacesForScopeKeys).not.toHaveBeenCalled();
    expect(registryMocks.removeRegistryEntryIfUnchanged).not.toHaveBeenCalled();
  });

  it("uses refreshed backend cleanup metadata when pruning a still-stale row", async () => {
    const stale = staleContainerEntry({
      backendId: "openshell",
      scope: "session",
      workspaceRoot: "/tmp/openclaw-sandboxes",
      lifecycleCleanupOnSessionEnd: true,
      cleanupMetadata: {
        openShellGateway: null,
      },
    });
    const refreshed = {
      ...stale,
      cleanupMetadata: {
        openShellGateway: "new-gateway",
      },
    };
    registryMocks.readRegistry
      .mockResolvedValueOnce({ entries: [stale] })
      .mockResolvedValueOnce({ entries: [refreshed] });

    await maybePruneSandboxes(buildPruneConfig());

    expect(workspaceMocks.removeSandboxWorkspacesForScopeKeys).not.toHaveBeenCalled();
    expect(backendMocks.removeRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        entry: expect.objectContaining({
          cleanupMetadata: {
            openShellGateway: "new-gateway",
          },
        }),
      }),
    );
    expect(registryMocks.removeRegistryEntryIfUnchanged).toHaveBeenCalledWith(refreshed);
  });

  it("does not infer session workspace ownership from the pruning caller config", async () => {
    await maybePruneSandboxes(buildPruneConfig());

    expect(workspaceMocks.removeSandboxWorkspacesForScopeKeys).not.toHaveBeenCalled();
    expect(registryMocks.removeRegistryEntryIfUnchanged).toHaveBeenCalledWith(
      expect.objectContaining({ containerName: "sandbox-1" }),
    );
  });

  it("prunes stale workspace-only rows when runtime creation never finalized", async () => {
    const workspaceEntry = {
      containerName: "workspace-row",
      sessionKey: "agent:main:thread-workspace-only",
      createdAtMs: Date.now() - 4 * 60 * 60 * 1000,
      lastUsedAtMs: Date.now() - 2 * 60 * 60 * 1000,
      scope: "session",
      workspaceRoot: "/tmp/openclaw-sandboxes",
      supersededWorkspaceRoots: ["/tmp/openclaw-sandboxes-old"],
      lifecycleCleanupOnSessionEnd: true,
    };
    registryMocks.readRegistry.mockResolvedValue({ entries: [] });
    registryMocks.readBrowserRegistry.mockResolvedValue({ entries: [] });
    registryMocks.readWorkspaceRegistry.mockResolvedValue({
      entries: [workspaceEntry],
    });

    await maybePruneSandboxes(buildPruneConfig());

    expect(workspaceMocks.removeSandboxWorkspacesForScopeKeys).toHaveBeenCalledWith({
      workspaceRoot: "/tmp/openclaw-sandboxes",
      scopeKeys: ["agent:main:thread-workspace-only"],
    });
    expect(workspaceMocks.removeSandboxWorkspacesForScopeKeys).toHaveBeenCalledWith({
      workspaceRoot: "/tmp/openclaw-sandboxes-old",
      scopeKeys: ["agent:main:thread-workspace-only"],
    });
    expect(registryMocks.removeWorkspaceRegistryEntryIfUnchanged).toHaveBeenCalledWith(
      workspaceEntry,
    );
  });

  it("does not prune workspace-only rows outside session lifecycle ownership", async () => {
    registryMocks.readRegistry.mockResolvedValue({ entries: [] });
    registryMocks.readBrowserRegistry.mockResolvedValue({ entries: [] });
    registryMocks.readWorkspaceRegistry.mockResolvedValue({
      entries: [
        {
          containerName: "workspace-agent-row",
          sessionKey: "agent:main",
          createdAtMs: Date.now() - 4 * 60 * 60 * 1000,
          lastUsedAtMs: Date.now() - 2 * 60 * 60 * 1000,
          scope: "agent",
          workspaceRoot: "/tmp/openclaw-sandboxes",
          lifecycleCleanupOnSessionEnd: false,
        },
      ],
    });

    await maybePruneSandboxes(buildPruneConfig());

    expect(workspaceMocks.removeSandboxWorkspacesForScopeKeys).not.toHaveBeenCalled();
    expect(registryMocks.removeWorkspaceRegistryEntryIfUnchanged).not.toHaveBeenCalled();
  });

  it("uses the registry owner's prune policy before removing session workspaces", async () => {
    configMocks.getRuntimeConfig.mockReturnValue(buildRuntimeConfig({ slowAgentIdleHours: 24 }));
    registryMocks.readRegistry.mockResolvedValue({
      entries: [
        staleContainerEntry({
          containerName: "sandbox-slow",
          sessionKey: "agent:slow:thread-1",
          scope: "session",
          workspaceRoot: "/tmp/openclaw-sandboxes",
          lifecycleCleanupOnSessionEnd: true,
        }),
      ],
    });

    await maybePruneSandboxes(buildPruneConfig());

    expect(backendMocks.removeRuntime).not.toHaveBeenCalled();
    expect(workspaceMocks.removeSandboxWorkspacesForScopeKeys).not.toHaveBeenCalled();
    expect(registryMocks.removeRegistryEntryIfUnchanged).not.toHaveBeenCalled();
  });

  it("does not prune session workspaces unless the row opted into lifecycle cleanup", async () => {
    registryMocks.readRegistry.mockResolvedValue({
      entries: [
        staleContainerEntry({
          scope: "session",
          workspaceRoot: "/tmp/openclaw-sandboxes",
          lifecycleCleanupOnSessionEnd: false,
        }),
      ],
    });

    await maybePruneSandboxes(buildPruneConfig());

    expect(workspaceMocks.removeSandboxWorkspacesForScopeKeys).not.toHaveBeenCalled();
    expect(registryMocks.removeRegistryEntryIfUnchanged).toHaveBeenCalledWith(
      expect.objectContaining({ containerName: "sandbox-1" }),
    );
  });

  it("keeps the registry entry when runtime removal fails", async () => {
    // The registry is the retry source; keep it until the backend confirms the
    // runtime was removed.
    backendMocks.removeRuntime.mockRejectedValueOnce(new Error("docker rm failed"));

    await maybePruneSandboxes(buildPruneConfig());

    expect(registryMocks.removeRegistryEntryIfUnchanged).not.toHaveBeenCalled();
    expect(runtimeMocks.error).toHaveBeenCalledWith(
      "Sandbox prune failed to remove sandbox-1: docker rm failed",
    );
  });

  it("keeps the workspace retry entry when workspace removal fails", async () => {
    const workspaceEntry = {
      containerName: "workspace-row",
      sessionKey: "agent:main:thread-1",
      createdAtMs: Date.now() - 4 * 60 * 60 * 1000,
      lastUsedAtMs: Date.now() - 2 * 60 * 60 * 1000,
      scope: "session",
      workspaceRoot: "/tmp/openclaw-sandboxes",
      lifecycleCleanupOnSessionEnd: true,
    };
    registryMocks.readRegistry.mockResolvedValue({
      entries: [
        staleContainerEntry({
          scope: "session",
          workspaceRoot: "/tmp/openclaw-sandboxes",
          lifecycleCleanupOnSessionEnd: true,
        }),
      ],
    });
    registryMocks.readWorkspaceRegistry.mockResolvedValue({
      entries: [workspaceEntry],
    });
    workspaceMocks.removeSandboxWorkspacesForScopeKeys.mockResolvedValueOnce({
      removedWorkspaces: 0,
      failures: [{ scopeKey: "agent:main:thread-1", error: "permission denied" }],
    });

    await maybePruneSandboxes(buildPruneConfig());

    expect(registryMocks.removeRegistryEntryIfUnchanged).toHaveBeenCalledWith(
      expect.objectContaining({ containerName: "sandbox-1" }),
    );
    expect(registryMocks.removeWorkspaceRegistryEntryIfUnchanged).not.toHaveBeenCalledWith(
      workspaceEntry,
    );
    expect(runtimeMocks.error).toHaveBeenCalledWith(
      "Sandbox prune failed to remove workspace for agent:main:thread-1: permission denied",
    );
  });

  it("keeps the owner workspace and retry rows when browser runtime removal fails", async () => {
    registryMocks.readRegistry.mockResolvedValue({
      entries: [
        staleContainerEntry({
          scope: "session",
          workspaceRoot: "/tmp/openclaw-sandboxes",
          lifecycleCleanupOnSessionEnd: true,
        }),
      ],
    });
    registryMocks.readBrowserRegistry.mockResolvedValue({
      entries: [
        staleBrowserEntry({
          scope: "session",
          workspaceRoot: "/tmp/openclaw-sandboxes",
          lifecycleCleanupOnSessionEnd: true,
        }),
      ],
    });
    backendMocks.removeRuntime.mockResolvedValueOnce(undefined);
    backendMocks.removeRuntime.mockRejectedValueOnce(new Error("browser rm failed"));

    await maybePruneSandboxes(buildPruneConfig());

    expect(workspaceMocks.removeSandboxWorkspacesForScopeKeys).not.toHaveBeenCalled();
    expect(registryMocks.removeRegistryEntryIfUnchanged).toHaveBeenCalledWith(
      expect.objectContaining({ containerName: "sandbox-1" }),
    );
    expect(registryMocks.removeBrowserRegistryEntryIfUnchanged).not.toHaveBeenCalledWith(
      expect.objectContaining({ containerName: "browser-1" }),
    );
    expect(runtimeMocks.error).toHaveBeenCalledWith(
      "Sandbox prune failed to remove browser-1: browser rm failed",
    );
  });

  it("finalizes a pruned runtime row while a fresh sibling keeps the workspace", async () => {
    const freshBrowser = staleBrowserEntry({
      scope: "session",
      workspaceRoot: "/tmp/openclaw-sandboxes",
      lifecycleCleanupOnSessionEnd: true,
      lastUsedAtMs: Date.now(),
    });
    registryMocks.readRegistry.mockResolvedValue({
      entries: [
        staleContainerEntry({
          scope: "session",
          workspaceRoot: "/tmp/openclaw-sandboxes",
          lifecycleCleanupOnSessionEnd: true,
        }),
      ],
    });
    registryMocks.readBrowserRegistry.mockResolvedValue({ entries: [freshBrowser] });

    await maybePruneSandboxes(buildPruneConfig());

    expect(backendMocks.removeRuntime).toHaveBeenCalledTimes(1);
    expect(workspaceMocks.removeSandboxWorkspacesForScopeKeys).not.toHaveBeenCalled();
    expect(registryMocks.removeRegistryEntryIfUnchanged).toHaveBeenCalledWith(
      expect.objectContaining({ containerName: "sandbox-1" }),
    );
    expect(registryMocks.removeBrowserRegistryEntryIfUnchanged).not.toHaveBeenCalled();
  });

  it("removes browser-only session workspaces after browser runtime removal succeeds", async () => {
    registryMocks.readRegistry.mockResolvedValue({ entries: [] });
    registryMocks.readBrowserRegistry.mockResolvedValue({
      entries: [
        staleBrowserEntry({
          scope: "session",
          workspaceRoot: "/tmp/openclaw-sandboxes",
          lifecycleCleanupOnSessionEnd: true,
        }),
      ],
    });

    await maybePruneSandboxes(buildPruneConfig());

    expect(workspaceMocks.removeSandboxWorkspacesForScopeKeys).toHaveBeenCalledWith({
      workspaceRoot: "/tmp/openclaw-sandboxes",
      scopeKeys: ["agent:main:thread-1"],
    });
    expect(registryMocks.removeBrowserRegistryEntryIfUnchanged).toHaveBeenCalledWith(
      expect.objectContaining({ containerName: "browser-1" }),
    );
  });

  it("passes the registry owner agent when pruning backend runtimes", async () => {
    await maybePruneSandboxes(buildPruneConfig());

    expect(backendMocks.removeRuntime).toHaveBeenCalledWith({
      entry: expect.objectContaining({
        containerName: "sandbox-1",
        sessionKey: "agent:main:thread-1",
      }),
      config: expect.any(Object),
      agentId: "main",
    });
  });

  it("prunes entries with out-of-range registry timestamps", async () => {
    const entries = [
      {
        containerName: "sandbox-out-of-range",
        backendId: "docker",
        sessionKey: "agent:main:out-of-range",
        createdAtMs: Date.now(),
        lastUsedAtMs: Number.MAX_SAFE_INTEGER,
        image: "openclaw-sandbox:bookworm-slim",
      },
    ];
    registryMocks.readRegistry
      .mockResolvedValueOnce({ entries })
      .mockResolvedValueOnce({ entries });

    await maybePruneSandboxes(buildPruneConfig());

    expect(backendMocks.removeRuntime).toHaveBeenCalledTimes(1);
    expect(registryMocks.removeRegistryEntryIfUnchanged).toHaveBeenCalledWith(
      expect.objectContaining({ containerName: "sandbox-out-of-range" }),
    );
  });
});
