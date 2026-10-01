// Sandbox prune tests cover runtime removal ordering and registry cleanup
// behavior for stale sandbox entries.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { SandboxRegistryEntry } from "./registry.js";

let maybePruneSandboxes: typeof import("./prune.js").maybePruneSandboxes;
let BROWSER_BRIDGES: typeof import("./browser-bridges.js").BROWSER_BRIDGES;

const configMocks = vi.hoisted(() => ({
  getRuntimeConfig: vi.fn(),
}));

const backendMocks = vi.hoisted(() => ({
  getSandboxBackendManager: vi.fn(),
  removeRuntime: vi.fn(),
}));

const registryMocks = vi.hoisted(() => ({
  assertSandboxBrowserRegistryEntryCurrent: vi.fn(),
  readBrowserRegistry: vi.fn(),
  readRegistry: vi.fn(),
  removeBrowserRegistryEntry: vi.fn(),
  removeRegistryEntry: vi.fn(),
}));

const runtimeMocks = vi.hoisted(() => ({
  error: vi.fn(),
}));

const bridgeMocks = vi.hoisted(() => ({
  stopBrowserBridgeServer: vi.fn(),
}));

vi.mock("../../config/config.js", () => ({
  getRuntimeConfig: configMocks.getRuntimeConfig,
}));

vi.mock("../../runtime.js", () => ({
  defaultRuntime: runtimeMocks,
}));

vi.mock("./backend.js", () => ({
  getSandboxBackendManager: backendMocks.getSandboxBackendManager,
  usesSandboxRuntimeReservations: () => false,
}));

vi.mock("./docker-backend.js", () => ({
  dockerSandboxBackendManager: backendMocks,
}));

vi.mock("./registry.js", () => ({
  assertSandboxBrowserRegistryEntryCurrent: registryMocks.assertSandboxBrowserRegistryEntryCurrent,
  readBrowserRegistry: registryMocks.readBrowserRegistry,
  readRegistry: registryMocks.readRegistry,
  removeBrowserRegistryEntry: registryMocks.removeBrowserRegistryEntry,
  removeRegistryEntry: registryMocks.removeRegistryEntry,
  removeSandboxRegistryGeneration: (
    _kind: string,
    entry: SandboxRegistryEntry,
    assertCurrent: () => void,
  ) => {
    assertCurrent();
    return registryMocks.removeBrowserRegistryEntry(entry.containerName);
  },
  removeSandboxRegistryRuntime: async (
    entry: SandboxRegistryEntry,
    removeRuntime: (current: SandboxRegistryEntry) => Promise<void>,
    options?: { shouldRemove?: (current: SandboxRegistryEntry) => boolean },
  ) => {
    if (options?.shouldRemove && !options.shouldRemove(entry)) {
      return;
    }
    await removeRuntime(entry);
    await registryMocks.removeRegistryEntry(entry.containerName);
  },
  withSandboxRegistryEntryLock: async (
    _entry: SandboxRegistryEntry,
    operation: () => Promise<unknown>,
  ) => operation(),
}));

vi.mock("../../plugin-sdk/browser-bridge.js", () => ({
  stopBrowserBridgeServer: bridgeMocks.stopBrowserBridgeServer,
}));

function buildPruneConfig(): OpenClawConfig {
  return {
    agents: {
      defaults: {
        sandbox: {
          mode: "all",
          prune: { idleHours: 1, maxAgeDays: 0 },
        },
      },
    },
  };
}

describe("maybePruneSandboxes", () => {
  beforeEach(async () => {
    vi.resetModules();
    configMocks.getRuntimeConfig.mockReset();
    registryMocks.assertSandboxBrowserRegistryEntryCurrent.mockReset();
    backendMocks.getSandboxBackendManager.mockReset().mockReturnValue(backendMocks);
    backendMocks.removeRuntime.mockReset();
    registryMocks.readBrowserRegistry.mockReset();
    registryMocks.readRegistry.mockReset();
    registryMocks.removeBrowserRegistryEntry.mockReset();
    registryMocks.removeRegistryEntry.mockReset();
    runtimeMocks.error.mockReset();
    bridgeMocks.stopBrowserBridgeServer.mockReset().mockResolvedValue(undefined);

    configMocks.getRuntimeConfig.mockReturnValue({});
    registryMocks.readBrowserRegistry.mockResolvedValue({ entries: [] });
    registryMocks.readRegistry.mockResolvedValue({
      entries: [
        {
          containerName: "sandbox-1",
          backendId: "docker",
          sessionKey: "agent:main:main",
          createdAtMs: Date.now() - 4 * 60 * 60 * 1000,
          lastUsedAtMs: Date.now() - 2 * 60 * 60 * 1000,
          image: "openclaw-sandbox:bookworm-slim",
        },
      ],
    });
    backendMocks.removeRuntime.mockResolvedValue(undefined);
    ({ BROWSER_BRIDGES } = await import("./browser-bridges.js"));
    BROWSER_BRIDGES.clear();
    ({ maybePruneSandboxes } = await import("./prune.js"));
  });

  it("removes the registry entry after runtime removal succeeds", async () => {
    await maybePruneSandboxes(buildPruneConfig());

    expect(backendMocks.removeRuntime).toHaveBeenCalledTimes(1);
    expect(registryMocks.removeRegistryEntry).toHaveBeenCalledWith("sandbox-1");
  });

  it("uses each registry owner's prune policy for containers and browsers", async () => {
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now);
    configMocks.getRuntimeConfig.mockReturnValue({
      agents: {
        defaults: {
          sandbox: { mode: "all", prune: { idleHours: 1, maxAgeDays: 0 } },
        },
        entries: {
          work: { sandbox: { prune: { idleHours: 24, maxAgeDays: 0 } } },
        },
      },
    });
    const entry = (containerName: string, agentId: string) => ({
      containerName,
      backendId: "docker",
      sessionKey: `agent:${agentId}:main`,
      createdAtMs: now - 4 * 60 * 60 * 1000,
      lastUsedAtMs: now - 2 * 60 * 60 * 1000,
      image: "openclaw-sandbox:bookworm-slim",
    });
    registryMocks.readRegistry.mockResolvedValue({
      entries: [entry("main-container", "main"), entry("work-container", "work")],
    });
    registryMocks.readBrowserRegistry.mockResolvedValue({
      entries: [
        { ...entry("main-browser", "main"), cdpPort: 9222 },
        { ...entry("work-browser", "work"), cdpPort: 9223 },
      ],
    });

    await maybePruneSandboxes();

    expect(
      backendMocks.removeRuntime.mock.calls.map(([params]) => params.entry.containerName),
    ).toEqual(["main-container", "main-browser"]);
    expect(backendMocks.removeRuntime.mock.calls.map(([params]) => params.agentId)).toEqual([
      "main",
      "main",
    ]);
    expect(registryMocks.removeRegistryEntry).toHaveBeenCalledExactlyOnceWith("main-container");
    expect(registryMocks.removeBrowserRegistryEntry).toHaveBeenCalledExactlyOnceWith(
      "main-browser",
    );
  });

  it("uses global prune policy for shared runtimes despite the caller override", async () => {
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now);
    configMocks.getRuntimeConfig.mockReturnValue({
      agents: {
        defaults: { sandbox: { mode: "all", prune: { idleHours: 24, maxAgeDays: 0 } } },
        entries: {
          main: { sandbox: { prune: { idleHours: 1, maxAgeDays: 0 } } },
        },
      },
    });
    registryMocks.readRegistry.mockResolvedValue({
      entries: [
        {
          containerName: "shared-runtime",
          backendId: "docker",
          sessionKey: "shared",
          createdAtMs: now - 4 * 60 * 60 * 1000,
          lastUsedAtMs: now - 2 * 60 * 60 * 1000,
          image: "openclaw-sandbox:bookworm-slim",
        },
      ],
    });
    registryMocks.readBrowserRegistry.mockResolvedValue({ entries: [] });

    await maybePruneSandboxes();

    expect(backendMocks.removeRuntime).not.toHaveBeenCalled();
  });

  it("keeps the registry entry when runtime removal fails", async () => {
    // The registry is the retry source; keep it until the backend confirms the
    // runtime was removed.
    backendMocks.removeRuntime.mockRejectedValueOnce(new Error("docker rm failed"));

    await maybePruneSandboxes(buildPruneConfig());

    expect(registryMocks.removeRegistryEntry).not.toHaveBeenCalled();
    expect(runtimeMocks.error).toHaveBeenCalledWith(
      "Sandbox prune failed to remove sandbox-1: docker rm failed",
    );
  });

  it("keeps the registry entry when its sandbox backend plugin is unavailable", async () => {
    backendMocks.getSandboxBackendManager.mockReturnValueOnce(null);
    registryMocks.readRegistry.mockResolvedValueOnce({
      entries: [
        {
          containerName: "openshell-1",
          backendId: "openshell",
          sessionKey: "agent:main:main",
          createdAtMs: Date.now() - 4 * 60 * 60 * 1000,
          lastUsedAtMs: Date.now() - 2 * 60 * 60 * 1000,
          image: "openclaw",
        },
      ],
    });

    await maybePruneSandboxes(buildPruneConfig());

    expect(registryMocks.removeRegistryEntry).not.toHaveBeenCalled();
    expect(runtimeMocks.error).toHaveBeenCalledWith(
      'Sandbox prune failed to remove openshell-1: Sandbox backend "openshell" is unavailable; enable its plugin before removing this runtime.',
    );
  });

  it("prunes entries with out-of-range registry timestamps", async () => {
    registryMocks.readRegistry.mockResolvedValueOnce({
      entries: [
        {
          containerName: "sandbox-out-of-range",
          backendId: "docker",
          sessionKey: "agent:main:main",
          createdAtMs: Date.now(),
          lastUsedAtMs: Number.MAX_SAFE_INTEGER,
          image: "openclaw-sandbox:bookworm-slim",
        },
      ],
    });

    await maybePruneSandboxes(buildPruneConfig());

    expect(backendMocks.removeRuntime).toHaveBeenCalledTimes(1);
    expect(registryMocks.removeRegistryEntry).toHaveBeenCalledWith("sandbox-out-of-range");
  });

  it("keeps browser runtime and registry state until bridge cleanup can retry", async () => {
    const now = Date.now();
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(now);
    registryMocks.readRegistry.mockResolvedValue({ entries: [] });
    registryMocks.readBrowserRegistry.mockResolvedValue({
      entries: [
        {
          containerName: "browser-1",
          sessionKey: "agent:coder:main",
          createdAtMs: now - 4 * 60 * 60 * 1000,
          lastUsedAtMs: now - 2 * 60 * 60 * 1000,
          image: "openclaw-sandbox-browser:bookworm-slim",
          cdpPort: 9222,
        },
      ],
    });
    const cached = { containerName: "browser-1", bridge: { server: {} } as never };
    BROWSER_BRIDGES.set("agent:coder:main", cached);
    bridgeMocks.stopBrowserBridgeServer.mockRejectedValueOnce(new Error("bridge cleanup failed"));

    await maybePruneSandboxes(buildPruneConfig());

    expect(BROWSER_BRIDGES.get("agent:coder:main")).toBe(cached);
    expect(backendMocks.removeRuntime).not.toHaveBeenCalled();
    expect(registryMocks.removeBrowserRegistryEntry).not.toHaveBeenCalled();
    expect(runtimeMocks.error).toHaveBeenCalledWith(
      "Sandbox prune failed to remove browser-1: bridge cleanup failed",
    );

    const order: string[] = [];
    bridgeMocks.stopBrowserBridgeServer.mockImplementationOnce(async () => {
      order.push("bridge");
    });
    backendMocks.removeRuntime.mockImplementationOnce(async () => {
      order.push("runtime");
    });
    registryMocks.removeBrowserRegistryEntry.mockImplementationOnce(async () => {
      order.push("registry");
    });
    nowSpy.mockReturnValue(now + 6 * 60 * 1000);

    await maybePruneSandboxes(buildPruneConfig());

    expect(order).toEqual(["bridge", "runtime", "registry"]);
    expect(BROWSER_BRIDGES.has("agent:coder:main")).toBe(false);
    nowSpy.mockRestore();
  });
});
