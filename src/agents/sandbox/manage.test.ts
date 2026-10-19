import { beforeEach, expect, it, vi } from "vitest";
import { BROWSER_BRIDGES } from "./browser-bridges.js";
import {
  listSandboxBrowsers,
  removeSandboxContainer,
  removeSandboxBrowserContainer,
} from "./manage.js";

const { configMocks, registryMocks, backendMocks, bridgeMocks } = vi.hoisted(() => ({
  configMocks: { getRuntimeConfig: vi.fn() },
  registryMocks: {
    readBrowserRegistry: vi.fn(),
    readRegistry: vi.fn(),
    removeBrowserRegistryEntry: vi.fn(),
    removeRegistryEntry: vi.fn(),
  },
  backendMocks: { describeRuntime: vi.fn(), removeRuntime: vi.fn() },
  bridgeMocks: { stopBrowserBridgeServer: vi.fn(async () => undefined) },
}));

// mock-isolation: Runtime config is supplied by each management scenario.
vi.mock("../../config/config.js", () => configMocks);
// mock-isolation: Browser cleanup is observed without opening a real bridge.
vi.mock("../../plugin-sdk/browser-bridge.js", () => bridgeMocks);
// mock-isolation: Synthetic registry rows isolate management from durable state.
vi.mock("./registry.js", () => registryMocks);

// mock-isolation: Backend effects are observed without creating containers.
vi.mock("./docker-backend.js", () => ({
  createDockerSandboxBackend: vi.fn(),
  createPodmanSandboxBackend: vi.fn(),
  dockerSandboxBackendManager: backendMocks,
  podmanSandboxBackendManager: {
    describeRuntime: vi.fn(),
    removeRuntime: vi.fn(),
  },
}));

beforeEach(async () => {
  for (const group of [configMocks, registryMocks, backendMocks]) {
    Object.values(group).forEach((mock) => mock.mockReset());
  }
  BROWSER_BRIDGES.clear();
  bridgeMocks.stopBrowserBridgeServer.mockReset().mockResolvedValue(undefined);

  configMocks.getRuntimeConfig.mockReturnValue({});
  registryMocks.readBrowserRegistry.mockResolvedValue({
    entries: [
      {
        containerName: "browser-1",
        sessionKey: "agent:coder:main",
        createdAtMs: 1,
        lastUsedAtMs: 1,
        image: "stale-entry-image",
        cdpPort: 9222,
      },
    ],
  });
  backendMocks.describeRuntime.mockResolvedValue({
    running: true,
    actualConfigLabel: "openclaw-sandbox-browser:trixie-slim",
    configLabelMatch: true,
  });
});

it("lists browser image metadata with the BrowserImage label", async () => {
  const results = await listSandboxBrowsers();
  expect(backendMocks.describeRuntime.mock.calls[0]?.[0]).toMatchObject({
    agentId: "coder",
    entry: { configLabelKind: "BrowserImage" },
  });
  expect(results).toMatchObject([
    { image: "openclaw-sandbox-browser:trixie-slim", running: true, imageMatch: true },
  ]);
});

it("removes browser runtimes with BrowserImage config label kind", async () => {
  const cached = { containerName: "browser-1", bridge: { server: {} } as never };
  BROWSER_BRIDGES.set("agent:coder:main", cached);

  await removeSandboxBrowserContainer("browser-1");

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
      {
        containerName: "openshell-1",
        backendId: "openshell",
        runtimeLabel: "openshell-1",
        sessionKey: "agent:coder:main",
        createdAtMs: 1,
        lastUsedAtMs: 1,
        image: "openclaw",
      },
    ],
  });

  await expect(removeSandboxContainer("openshell-1")).rejects.toThrow(
    'Sandbox backend "openshell" is unavailable',
  );
  expect(registryMocks.removeRegistryEntry).not.toHaveBeenCalled();
});

it("retains the exact bridge owner when cleanup fails", async () => {
  const cached = { containerName: "browser-1", bridge: { server: {} } as never };
  BROWSER_BRIDGES.set("agent:coder:main", cached);
  bridgeMocks.stopBrowserBridgeServer.mockRejectedValueOnce(new Error("bridge cleanup failed"));

  await expect(removeSandboxBrowserContainer("browser-1")).rejects.toThrow("bridge cleanup failed");

  expect(BROWSER_BRIDGES.get("agent:coder:main")).toBe(cached);
  expect(backendMocks.removeRuntime).not.toHaveBeenCalled();
  expect(registryMocks.removeBrowserRegistryEntry).not.toHaveBeenCalled();

  await expect(removeSandboxBrowserContainer("browser-1")).resolves.toBeUndefined();
  expect(BROWSER_BRIDGES.has("agent:coder:main")).toBe(false);
  expect(backendMocks.removeRuntime).toHaveBeenCalledOnce();
  expect(registryMocks.removeBrowserRegistryEntry).toHaveBeenCalledOnce();
});
