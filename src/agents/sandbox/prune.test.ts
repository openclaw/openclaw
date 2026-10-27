import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { withEnvAsync } from "../../test-utils/env.js";
import type { SandboxRegistryEntry } from "./registry.js";
import { acquireSandboxGatewayOwner } from "./registry.test-support.js";
import { captureSandboxStateOwner } from "./state-owner.js";

let maybePruneSandboxes: typeof import("./prune.js").maybePruneSandboxes;
let BROWSER_BRIDGES: typeof import("./browser-bridges.js").BROWSER_BRIDGES;
let management: typeof import("./manage.js");
const roots = useAutoCleanupTempDirTracker(afterEach);

const { configMocks, backendMocks, registryMocks, runtimeMocks, bridgeMocks, persistentExecMocks } =
  vi.hoisted(() => ({
    configMocks: { getRuntimeConfig: vi.fn() },
    backendMocks: {
      removeRuntime: vi.fn(),
      describeRuntime: vi.fn(),
    },
    registryMocks: {
      assertSandboxBrowserRegistryEntryCurrent: vi.fn(),
      readBrowserRegistry: vi.fn(),
      readRegistry: vi.fn(),
      removeBrowserRegistryEntry: vi.fn(),
      removeRegistryEntry: vi.fn(),
    },
    runtimeMocks: { error: vi.fn() },
    bridgeMocks: { stopBrowserBridgeServer: vi.fn() },
    persistentExecMocks: {
      recoverSandboxPersistentExecOrphans:
        vi.fn<typeof import("./persistent-exec.js").recoverSandboxPersistentExecOrphans>(),
    },
  }));

vi.mock("../../config/config.js", () => ({
  getRuntimeConfig: configMocks.getRuntimeConfig,
}));

vi.mock("../../runtime.js", () => ({
  defaultRuntime: runtimeMocks,
}));

// mock-isolation: Pruning uses synthetic managers without loading native Docker/Podman backends.
vi.mock("./docker-backend.js", () => ({
  createDockerSandboxBackend: vi.fn(),
  createPodmanSandboxBackend: vi.fn(),
  dockerSandboxBackendManager: backendMocks,
  podmanSandboxBackendManager: { describeRuntime: vi.fn(), removeRuntime: vi.fn() },
}));

// mock-isolation: Persistent-exec tests own recovery; this fixture proves pruning continues after failure.
vi.mock("./persistent-exec.js", () => persistentExecMocks);

// mock-isolation: Prune selection uses synthetic rows; worker predicate behavior lives in registry tests.
vi.mock("./registry.js", () => ({
  assertSandboxRegistryRetirementCurrent: (_kind: string, current: unknown) =>
    registryMocks.assertSandboxBrowserRegistryEntryCurrent(current),
  readBrowserRegistry: registryMocks.readBrowserRegistry,
  readRegistry: registryMocks.readRegistry,
  removeBrowserRegistryEntry: registryMocks.removeBrowserRegistryEntry,
  removeRegistryEntry: registryMocks.removeRegistryEntry,
  removeSandboxRegistryGeneration: (
    _kind: string,
    current: SandboxRegistryEntry,
    assertCurrent?: () => void,
  ) => {
    assertCurrent?.();
    return registryMocks.removeBrowserRegistryEntry(current.containerName);
  },
  removeSandboxRegistryRuntime: async (
    current: SandboxRegistryEntry,
    removeRuntime: (current: SandboxRegistryEntry) => Promise<void>,
  ) => {
    await removeRuntime(current);
    await registryMocks.removeRegistryEntry(current.containerName);
  },
  withSandboxRegistryEntryLock: async (
    _entry: SandboxRegistryEntry,
    operation: () => Promise<unknown>,
  ) => operation(),
}));

vi.mock("../../plugin-sdk/browser-bridge.js", () => ({
  stopBrowserBridgeServer: bridgeMocks.stopBrowserBridgeServer,
}));

const prunePolicy = { idleHours: 1, maxAgeDays: 0 };
const pruneConfig: OpenClawConfig = {
  agents: { defaults: { sandbox: { mode: "all", prune: prunePolicy } } },
};
const browserEntry = (image = "openclaw-sandbox-browser:trixie-slim") => ({
  ...entry("browser-1", "coder", { image }),
  cdpPort: 9222,
});
function cacheBrowser() {
  const cached = { containerName: "browser-1", bridge: { server: {} } as never };
  BROWSER_BRIDGES.set("agent:coder:main", cached);
  return cached;
}
function expectBrowserRetained(cached: ReturnType<typeof cacheBrowser>) {
  expect(BROWSER_BRIDGES.get("agent:coder:main")).toBe(cached);
  expect(backendMocks.removeRuntime).not.toHaveBeenCalled();
  expect(registryMocks.removeBrowserRegistryEntry).not.toHaveBeenCalled();
}
function entry(
  containerName: string,
  agentId = "main",
  overrides: Partial<SandboxRegistryEntry> = {},
) {
  return {
    containerName,
    backendId: "docker",
    sessionKey: `agent:${agentId}:main`,
    createdAtMs: Date.now() - 4 * 60 * 60 * 1000,
    lastUsedAtMs: Date.now() - 2 * 60 * 60 * 1000,
    image: "openclaw-sandbox:trixie-slim",
    ...overrides,
  };
}

beforeEach(async () => {
  vi.resetModules();
  for (const mock of [configMocks, registryMocks, runtimeMocks, bridgeMocks]) {
    Object.values(mock).forEach((fn) => fn.mockReset());
  }
  backendMocks.removeRuntime.mockReset().mockResolvedValue(undefined);
  backendMocks.describeRuntime.mockReset().mockResolvedValue({
    running: true,
    actualConfigLabel: "openclaw-sandbox-browser:trixie-slim",
    configLabelMatch: true,
  });
  bridgeMocks.stopBrowserBridgeServer.mockResolvedValue(undefined);
  persistentExecMocks.recoverSandboxPersistentExecOrphans.mockReset().mockResolvedValue(undefined);

  configMocks.getRuntimeConfig.mockReturnValue({});
  registryMocks.readBrowserRegistry.mockResolvedValue({ entries: [] });
  registryMocks.readRegistry.mockResolvedValue({ entries: [entry("sandbox-1")] });
  ({ BROWSER_BRIDGES } = await import("./browser-bridges.js"));
  BROWSER_BRIDGES.clear();
  ({ maybePruneSandboxes } = await import("./prune.js"));
  management = await import("./manage.js");
});

describe("maybePruneSandboxes", () => {
  it("reports orphan recovery failure and still removes the ordinary runtime and registry entry", async () => {
    persistentExecMocks.recoverSandboxPersistentExecOrphans.mockRejectedValueOnce(
      new Error("original Docker daemon unavailable"),
    );

    await maybePruneSandboxes(pruneConfig);

    expect(runtimeMocks.error).toHaveBeenCalledWith(
      "Sandbox stream allocation cleanup failed: original Docker daemon unavailable",
    );
    expect(backendMocks.removeRuntime).toHaveBeenCalledTimes(1);
    expect(registryMocks.removeRegistryEntry).toHaveBeenCalledWith("sandbox-1");
  });

  it("rejects hosted custody released during registry inspection before runtime removal", async () => {
    const root = roots.make("sandbox-prune-custody-");
    await withEnvAsync({ OPENCLAW_STATE_DIR: root }, async () => {
      const owner = acquireSandboxGatewayOwner(root);
      const assertCurrent = await captureSandboxStateOwner();
      const entered = createDeferred();
      const resume = createDeferred();
      const staleRegistry = await registryMocks.readRegistry();
      registryMocks.readRegistry.mockImplementationOnce(async () => {
        entered.resolve();
        await resume.promise;
        return staleRegistry;
      });
      const pruning = maybePruneSandboxes(pruneConfig, assertCurrent);
      try {
        await awaitGateBeforeSettlement(
          entered.promise,
          pruning,
          "Pruning skipped registry inspection",
        );
        owner.release();
        resume.resolve();
        const result = await pruning.catch((error: unknown) => error);
        expect(backendMocks.removeRuntime).not.toHaveBeenCalled();
        expect(registryMocks.removeRegistryEntry).not.toHaveBeenCalled();
        expect(result).toMatchObject({ code: "GATEWAY_STATE_OWNER_REQUIRED" });
      } finally {
        resume.resolve();
        await pruning.catch(() => {});
        owner.release();
      }
    });
  });

  it("uses each registry owner's prune policy for containers and browsers", async () => {
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now);
    configMocks.getRuntimeConfig.mockReturnValue({
      agents: {
        defaults: pruneConfig.agents?.defaults,
        entries: {
          work: { sandbox: { prune: { idleHours: 24, maxAgeDays: 0 } } },
        },
      },
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
      entries: [entry("shared-runtime", "main", { sessionKey: "shared" })],
    });

    await maybePruneSandboxes();

    expect(backendMocks.removeRuntime).not.toHaveBeenCalled();
  });

  it("keeps the registry entry when runtime removal fails", async () => {
    backendMocks.removeRuntime.mockRejectedValueOnce(new Error("docker rm failed"));

    await maybePruneSandboxes(pruneConfig);

    expect(registryMocks.removeRegistryEntry).not.toHaveBeenCalled();
    expect(runtimeMocks.error).toHaveBeenCalledWith(
      "Sandbox prune failed to remove sandbox-1: docker rm failed",
    );
  });

  it("keeps the registry entry when its sandbox backend plugin is unavailable", async () => {
    registryMocks.readRegistry.mockResolvedValueOnce({
      entries: [entry("openshell-1", "main", { backendId: "openshell", image: "openclaw" })],
    });

    await maybePruneSandboxes(pruneConfig);

    expect(registryMocks.removeRegistryEntry).not.toHaveBeenCalled();
    expect(runtimeMocks.error).toHaveBeenCalledWith(
      'Sandbox prune failed to remove openshell-1: Sandbox backend "openshell" is unavailable; enable its plugin before removing this runtime.',
    );
  });

  it("prunes entries with out-of-range registry timestamps", async () => {
    registryMocks.readRegistry.mockResolvedValueOnce({
      entries: [
        entry("sandbox-out-of-range", "main", {
          createdAtMs: Date.now(),
          lastUsedAtMs: Number.MAX_SAFE_INTEGER,
        }),
      ],
    });

    await maybePruneSandboxes(pruneConfig);

    expect(backendMocks.removeRuntime).toHaveBeenCalledTimes(1);
    expect(registryMocks.removeRegistryEntry).toHaveBeenCalledWith("sandbox-out-of-range");
  });

  it("keeps browser runtime and registry state until bridge cleanup can retry", async () => {
    const now = Date.now();
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(now);
    registryMocks.readRegistry.mockResolvedValue({ entries: [] });
    registryMocks.readBrowserRegistry.mockResolvedValue({
      entries: [{ ...browserEntry(), backendId: undefined }],
    });
    const cached = cacheBrowser();
    bridgeMocks.stopBrowserBridgeServer.mockRejectedValueOnce(new Error("bridge cleanup failed"));

    await maybePruneSandboxes(pruneConfig);

    expectBrowserRetained(cached);
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

    await maybePruneSandboxes(pruneConfig);

    expect(order).toEqual(["bridge", "runtime", "registry"]);
    expect(BROWSER_BRIDGES.has("agent:coder:main")).toBe(false);
    nowSpy.mockRestore();
  });
});

describe("sandbox management", () => {
  beforeEach(() => {
    registryMocks.readBrowserRegistry.mockResolvedValue({
      entries: [browserEntry("stale-entry-image")],
    });
  });

  it("lists browser image metadata with the BrowserImage label", async () => {
    const results = await management.listSandboxBrowsers();
    expect(backendMocks.describeRuntime.mock.calls[0]?.[0]).toMatchObject({
      agentId: "coder",
      entry: { configLabelKind: "BrowserImage" },
    });
    expect(results).toMatchObject([
      { image: "openclaw-sandbox-browser:trixie-slim", running: true, imageMatch: true },
    ]);
  });

  it("removes browser runtimes with BrowserImage config label kind", async () => {
    cacheBrowser();
    await management.removeSandboxBrowserContainer("browser-1");
    const runtimeOrder = backendMocks.removeRuntime.mock.invocationCallOrder[0]!;
    expect(bridgeMocks.stopBrowserBridgeServer.mock.invocationCallOrder[0]).toBeLessThan(
      runtimeOrder,
    );
    expect(registryMocks.removeBrowserRegistryEntry.mock.invocationCallOrder[0]).toBeGreaterThan(
      runtimeOrder,
    );
    expect(BROWSER_BRIDGES.has("agent:coder:main")).toBe(false);
    expect(backendMocks.removeRuntime.mock.calls[0]?.[0]).toMatchObject({
      entry: {
        containerName: "browser-1",
        configLabelKind: "BrowserImage",
        runtimeLabel: "browser-1",
        backendId: "docker",
      },
    });
    expect(registryMocks.removeBrowserRegistryEntry).toHaveBeenCalledWith("browser-1");
  });

  it("preserves a sandbox registry entry when its backend plugin is unavailable", async () => {
    registryMocks.readRegistry.mockResolvedValue({
      entries: [
        entry("openshell-1", "coder", {
          backendId: "openshell",
          runtimeLabel: "openshell-1",
          image: "openclaw",
        }),
      ],
    });
    await expect(management.removeSandboxContainer("openshell-1")).rejects.toThrow(
      'Sandbox backend "openshell" is unavailable',
    );
    expect(registryMocks.removeRegistryEntry).not.toHaveBeenCalled();
  });

  it("retains the exact bridge owner when cleanup fails", async () => {
    const cached = cacheBrowser();
    bridgeMocks.stopBrowserBridgeServer.mockRejectedValueOnce(new Error("bridge cleanup failed"));
    await expect(management.removeSandboxBrowserContainer("browser-1")).rejects.toThrow(
      "bridge cleanup failed",
    );
    expectBrowserRetained(cached);
    await expect(management.removeSandboxBrowserContainer("browser-1")).resolves.toBeUndefined();
    expect(BROWSER_BRIDGES.has("agent:coder:main")).toBe(false);
    expect(backendMocks.removeRuntime).toHaveBeenCalledOnce();
    expect(registryMocks.removeBrowserRegistryEntry).toHaveBeenCalledOnce();
  });
});
