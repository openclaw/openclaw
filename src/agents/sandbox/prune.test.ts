import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { createEnteredGate } from "../entered-gate.test-support.js";
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
  ...registryMocks,
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
  it("rejects hosted custody released during registry inspection before runtime removal", async () => {
    const root = roots.make("sandbox-prune-custody-");
    await withEnvAsync({ OPENCLAW_STATE_DIR: root }, async () => {
      const owner = acquireSandboxGatewayOwner(root);
      const assertCurrent = await captureSandboxStateOwner();
      const registryRead = createEnteredGate();
      const staleRegistry = await registryMocks.readRegistry();
      registryMocks.readRegistry.mockImplementationOnce(async () => {
        await registryRead.wait();
        return staleRegistry;
      });
      const pruning = maybePruneSandboxes(pruneConfig, assertCurrent);
      try {
        await awaitGateBeforeSettlement(
          registryRead.entered,
          pruning,
          "Pruning skipped registry inspection",
        );
        owner.release();
        registryRead.release();
        const result = await pruning.catch((error: unknown) => error);
        expect(backendMocks.removeRuntime).not.toHaveBeenCalled();
        expect(registryMocks.removeRegistryEntry).not.toHaveBeenCalled();
        expect(result).toMatchObject({ code: "GATEWAY_STATE_OWNER_REQUIRED" });
      } finally {
        registryRead.release();
        await pruning.catch(() => {});
        owner.release();
      }
    });
  });

  it.each([false, true])("uses the owning prune policy (shared=%s)", async (shared) => {
    configMocks.getRuntimeConfig.mockReturnValue({
      agents: {
        defaults: {
          sandbox: { mode: "all", prune: { idleHours: shared ? 24 : 1, maxAgeDays: 0 } },
        },
        entries: {
          main: { sandbox: { prune: { idleHours: 1, maxAgeDays: 0 } } },
          work: { sandbox: { prune: { idleHours: 24, maxAgeDays: 0 } } },
        },
      },
    });
    registryMocks.readRegistry.mockResolvedValue({
      entries: shared
        ? [entry("shared-runtime", "main", { sessionKey: "shared" })]
        : [entry("main-container", "main"), entry("work-container", "work")],
    });
    registryMocks.readBrowserRegistry.mockResolvedValue({
      entries: shared
        ? []
        : [
            { ...entry("main-browser", "main"), cdpPort: 9222 },
            { ...entry("work-browser", "work"), cdpPort: 9223 },
          ],
    });
    await maybePruneSandboxes();
    expect(
      backendMocks.removeRuntime.mock.calls.map(([params]) => params.entry.containerName),
    ).toEqual(shared ? [] : ["main-container", "main-browser"]);
    expect(backendMocks.removeRuntime.mock.calls.map(([params]) => params.agentId)).toEqual(
      shared ? [] : ["main", "main"],
    );
    if (!shared) {
      expect(registryMocks.removeRegistryEntry).toHaveBeenCalledExactlyOnceWith("main-container");
      expect(registryMocks.removeBrowserRegistryEntry).toHaveBeenCalledExactlyOnceWith(
        "main-browser",
      );
    }
  });

  it.each(["orphan recovery", "runtime removal", "invalid timestamp"])(
    "settles registry cleanup after %s",
    async (scenario) => {
      const name = scenario === "invalid timestamp" ? "sandbox-out-of-range" : "sandbox-1";
      registryMocks.readRegistry.mockResolvedValue({
        entries: [
          entry(
            name,
            "main",
            scenario === "invalid timestamp"
              ? { createdAtMs: Date.now(), lastUsedAtMs: Number.MAX_SAFE_INTEGER }
              : {},
          ),
        ],
      });
      if (scenario === "orphan recovery") {
        persistentExecMocks.recoverSandboxPersistentExecOrphans.mockRejectedValueOnce(
          new Error("original Docker daemon unavailable"),
        );
      } else if (scenario === "runtime removal") {
        backendMocks.removeRuntime.mockRejectedValueOnce(new Error("docker rm failed"));
      }
      await maybePruneSandboxes(pruneConfig);
      if (scenario === "runtime removal") {
        expect(registryMocks.removeRegistryEntry).not.toHaveBeenCalled();
      } else {
        expect(backendMocks.removeRuntime).toHaveBeenCalledTimes(1);
        expect(registryMocks.removeRegistryEntry).toHaveBeenCalledWith(name);
      }
      const error =
        scenario === "runtime removal"
          ? "Sandbox prune failed to remove sandbox-1: docker rm failed"
          : "Sandbox stream allocation cleanup failed: original Docker daemon unavailable";
      if (scenario !== "invalid timestamp") {
        expect(runtimeMocks.error).toHaveBeenCalledWith(error);
      }
    },
  );
});

it.each(["prune", "management"] as const)(
  "retains browser custody until %s cleanup can retry",
  async (mode) => {
    registryMocks.readRegistry.mockResolvedValue({ entries: [] });
    registryMocks.readBrowserRegistry.mockResolvedValue({
      entries: [{ ...browserEntry("stale-entry-image"), backendId: undefined }],
    });
    const cached = cacheBrowser();
    const remove = () =>
      mode === "prune"
        ? maybePruneSandboxes(pruneConfig)
        : management.removeSandboxBrowserContainer("browser-1");
    bridgeMocks.stopBrowserBridgeServer.mockRejectedValueOnce(new Error("bridge cleanup failed"));
    if (mode === "prune") {
      await remove();
      expect(runtimeMocks.error).toHaveBeenCalledWith(
        "Sandbox prune failed to remove browser-1: bridge cleanup failed",
      );
    } else {
      await expect(remove()).rejects.toThrow("bridge cleanup failed");
    }
    expectBrowserRetained(cached);
    const order: string[] = [];
    for (const [name, mock] of [
      ["bridge", bridgeMocks.stopBrowserBridgeServer],
      ["runtime", backendMocks.removeRuntime],
      ["registry", registryMocks.removeBrowserRegistryEntry],
    ] as const) {
      mock.mockImplementationOnce(async () => {
        order.push(name);
      });
    }
    using clock = vi.spyOn(Date, "now");
    clock.mockReturnValue(Date.now() + 6 * 60 * 1000);
    await expect(remove()).resolves.toBeUndefined();
    expect(order).toEqual(["bridge", "runtime", "registry"]);
    expect(BROWSER_BRIDGES.has("agent:coder:main")).toBe(false);
    expect(backendMocks.removeRuntime).toHaveBeenCalledOnce();
    expect(registryMocks.removeBrowserRegistryEntry).toHaveBeenCalledOnce();
    if (mode === "management") {
      expect(backendMocks.removeRuntime.mock.calls[0]?.[0]).toMatchObject({
        entry: {
          containerName: "browser-1",
          configLabelKind: "BrowserImage",
          runtimeLabel: "browser-1",
          backendId: "docker",
        },
      });
      expect(registryMocks.removeBrowserRegistryEntry).toHaveBeenCalledWith("browser-1");
    }
  },
);

it("lists browser image metadata with the BrowserImage label", async () => {
  registryMocks.readBrowserRegistry.mockResolvedValue({
    entries: [browserEntry("stale-entry-image")],
  });
  const results = await management.listSandboxBrowsers();
  expect(backendMocks.describeRuntime.mock.calls[0]?.[0]).toMatchObject({
    agentId: "coder",
    entry: { configLabelKind: "BrowserImage" },
  });
  expect(results).toMatchObject([
    { image: "openclaw-sandbox-browser:trixie-slim", running: true, imageMatch: true },
  ]);
});

it.each(["prune", "management"] as const)(
  "preserves unavailable backend custody during %s",
  async (mode) => {
    registryMocks.readRegistry.mockResolvedValue({
      entries: [
        entry("openshell-1", "coder", {
          backendId: "openshell",
          runtimeLabel: "openshell-1",
          image: "openclaw",
        }),
      ],
    });
    const message =
      'Sandbox backend "openshell" is unavailable; enable its plugin before removing this runtime.';
    if (mode === "prune") {
      await maybePruneSandboxes(pruneConfig);
      expect(runtimeMocks.error).toHaveBeenCalledWith(
        `Sandbox prune failed to remove openshell-1: ${message}`,
      );
    } else {
      await expect(management.removeSandboxContainer("openshell-1")).rejects.toThrow(message);
    }
    expect(registryMocks.removeRegistryEntry).not.toHaveBeenCalled();
  },
);
