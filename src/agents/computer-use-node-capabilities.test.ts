import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { startComputerHostProcess } from "../gateway/desktop/computer-process.js";
import { createGatewayComputerService } from "../gateway/desktop/computer-service.js";
import { computerCapabilities } from "../gateway/desktop/computer.test-support.js";
import { NodeRegistry } from "../gateway/node-registry.js";
import { makeClient, registerNodeSession } from "../gateway/node-registry.test-helpers.js";
import type { GatewayRequestContext } from "../gateway/server-methods/types.js";
import type { DevicePairingNodeSnapshot } from "../infra/device-pairing-read.types.js";
import { readDevicePairingNodeSnapshot } from "../infra/device-pairing-store-readonly.js";
import type { ComputerUseV2ActionName } from "../plugins/computer-use-contract.js";
import { registerComputerUseProvider } from "../plugins/computer-use-registration.js";
import { createPluginRecord } from "../plugins/loader-records.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { withPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import {
  loadPairedComputerUseAvailabilityForSurface,
  type PreparedPairedComputerUse,
} from "./computer-use-node-capabilities.js";
import { loadGatewayComputerStatus } from "./tools/computer-tool-gateway.js";
import { withGatewayToolCallerIdentity } from "./tools/gateway-caller-context.js";
import { listNodes } from "./tools/nodes-utils.js";

vi.mock("../infra/device-pairing-store-readonly.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/device-pairing-store-readonly.js")>()),
  readDevicePairingNodeSnapshot: vi.fn(),
}));
vi.mock("./tools/nodes-utils.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./tools/nodes-utils.js")>()),
  listNodes: vi.fn(),
}));
vi.mock("./tools/computer-tool-gateway.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./tools/computer-tool-gateway.js")>()),
  loadGatewayComputerStatus: vi.fn(),
}));
vi.mock("../gateway/desktop/computer-process.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../gateway/desktop/computer-process.js")>()),
  startComputerHostProcess: vi.fn(),
}));

const registries: NodeRegistry[] = [];
const services: ReturnType<typeof createGatewayComputerService>[] = [];
let pairing: DevicePairingNodeSnapshot;

beforeEach(() => {
  pairing = { paired: [], bindings: new Map() };
  vi.mocked(readDevicePairingNodeSnapshot).mockImplementation(async () => pairing);
  vi.mocked(listNodes).mockResolvedValue([]);
  vi.mocked(loadGatewayComputerStatus).mockResolvedValue({ configured: false, available: false });
});

afterEach(async () => {
  for (const registry of registries.splice(0)) {
    for (const session of registry.listConnected()) {
      registry.unregister(session.connId);
    }
  }
  for (const service of services.splice(0)) {
    await service.close();
  }
  vi.useRealTimers();
  vi.clearAllMocks();
});

const capabilities = (actions: ComputerUseV2ActionName[]) =>
  computerCapabilities(
    { id: "fixture", label: "Fixture computer", generation: "fixture-generation" },
    actions,
  );

function createContext(gatewayComputerService?: GatewayRequestContext["gatewayComputerService"]) {
  const nodeRegistry = new NodeRegistry();
  registries.push(nodeRegistry);
  return { nodeRegistry, gatewayComputerService } as GatewayRequestContext;
}

function connect(
  context: GatewayRequestContext,
  nodeId: string,
  actions: ComputerUseV2ActionName[],
) {
  pairing = {
    ...pairing,
    bindings: new Map([...pairing.bindings, [nodeId, { identity: "identity-a" }]]),
  };
  const client = makeClient(`connection-${nodeId}`, nodeId, [], {
    platform: "macos",
    caps: ["computer", "screen"],
    commands: ["computer.act", "screen.snapshot"],
    computerUse: capabilities(actions),
  });
  client.connect.client.deviceFamily = "Mac";
  registerNodeSession(context.nodeRegistry, client);
}

const load = () => loadPairedComputerUseAvailabilityForSurface({ computerAllowed: true });
const withContext = <T>(
  context: GatewayRequestContext | (() => GatewayRequestContext | undefined),
  run: () => Promise<T>,
) =>
  withGatewayToolCallerIdentity(
    {
      agentId: "main",
      sessionKey: "agent:main:computer-discovery",
      gatewayContextResolver: typeof context === "function" ? context : () => context,
    },
    run,
  );
async function expectPrepared(
  expected: Partial<Omit<PreparedPairedComputerUse, "gateway">> & {
    gateway?: Partial<NonNullable<PreparedPairedComputerUse["gateway"]>>;
  },
  context?: GatewayRequestContext,
) {
  const result = await (context ? withContext(context, load) : load());
  expect(result?.prepared).toMatchObject(expected);
}

it("updates the advertised surface after the local node and pairing owners change", async () => {
  const context = createContext();
  await withContext(context, async () => {
    await expectPrepared({ actions: [] });
    connect(context, "paired-node", ["screenshot", "left_click"]);
    const connected = await load();
    expect(connected?.prepared).toMatchObject({
      actions: ["screenshot", "left_click"],
      guidanceCapabilities: { provider: { id: "fixture" } },
    });

    context.nodeRegistry.refreshRuntimePolicy({
      gateway: { nodes: { commands: { deny: ["computer.act"] } } },
    });
    await expectPrepared({ actions: [] });
    context.nodeRegistry.refreshRuntimePolicy({});
    await expectPrepared({ actions: ["screenshot", "left_click"] });

    pairing = { paired: [], bindings: new Map() };
    await expectPrepared({ actions: [] });
    connect(context, "paired-node", ["screenshot", "type"]);
    const reconnected = await load();
    expect(reconnected?.prepared?.actions).toEqual(["screenshot", "type"]);
    expect(reconnected?.cacheKey).not.toBe(connected?.cacheKey);
    context.nodeRegistry.unregister("connection-paired-node");
    await expectPrepared({ actions: [] });
  });
});

it("observes the local computer owner's config and provider publications", async () => {
  vi.useFakeTimers();
  let config: OpenClawConfig = { plugins: { entries: { fixture: { enabled: true } } } };
  const registry = createEmptyPluginRegistry();
  registry.plugins.push(
    createPluginRecord({
      id: "fixture",
      source: "fixture",
      origin: "bundled",
      enabled: true,
      configSchema: false,
    }),
  );
  const publishProvider = (actions: ComputerUseV2ActionName[]) => {
    registry.nodeHostCommands.length = 0;
    registerComputerUseProvider(
      {
        registerNodeHostCommand: (command) =>
          registry.nodeHostCommands.push({
            pluginId: "fixture",
            pluginName: "Fixture",
            command,
            source: "fixture",
          }),
      },
      {
        id: "fixture",
        label: "Fixture computer",
        capabilities: () => capabilities(actions),
        isAvailable: () => true,
        openExecution: async () => {
          throw new Error("Discovery must not open an execution");
        },
      },
    );
  };
  publishProvider(["screenshot", "left_click"]);
  const service = createGatewayComputerService({
    getConfig: () => config,
    getPluginRegistry: () => registry,
  });
  services.push(service);
  const context = createContext(service);
  await withContext(context, async () => {
    await expectPrepared({
      actions: ["screenshot", "left_click"],
      gateway: { configured: true, available: false },
    });
    expect(startComputerHostProcess).not.toHaveBeenCalled();

    let active = true;
    vi.mocked(startComputerHostProcess).mockReturnValue({
      ready: Promise.resolve(capabilities(["screenshot", "left_click"])),
      isCurrent: () => active,
      invoke: async () => {
        throw new Error("Discovery must not invoke the computer");
      },
      close: async () => {
        active = false;
      },
    });
    await service.status({ probe: true });
    await expectPrepared({ gateway: { configured: true, available: true } });
    active = false;
    await expectPrepared({ gateway: { configured: true, available: false } });

    publishProvider(["screenshot", "type"]);
    await expectPrepared({ actions: ["screenshot", "type"] });

    config = { plugins: { entries: { fixture: { enabled: false } } } };
    await expectPrepared({
      actions: [],
      gateway: { configured: false, available: false },
    });
    config = { plugins: { entries: { fixture: { enabled: true } } } };
    await expectPrepared({ actions: ["screenshot", "type"] });
  });
});

it("keeps inventory scoped to its admitted Gateway and rejects retired bindings locally", async () => {
  const first = createContext();
  const second = createContext();
  connect(first, "first-node", ["screenshot", "left_click"]);
  connect(second, "second-node", ["screenshot", "type"]);
  await expectPrepared({ actions: ["screenshot", "left_click"] }, first);
  await expectPrepared({ actions: ["screenshot", "type"] }, second);

  let current: GatewayRequestContext | undefined = first;
  await withContext(
    () => current,
    async () => {
      current = second;
      const retired = await withPluginRuntimeGatewayRequestScope(
        { context: second, isWebchatConnect: () => false },
        load,
      );
      expect(retired?.prepared).toMatchObject({
        actions: [],
        gateway: {
          configured: true,
          available: false,
          error: "Gateway context is no longer available",
        },
      });
    },
  );
  expect(listNodes).not.toHaveBeenCalled();
  expect(loadGatewayComputerStatus).not.toHaveBeenCalled();
});

it("retains transport discovery for CLI and embedded callers", async () => {
  vi.mocked(listNodes).mockResolvedValue([
    {
      nodeId: "remote-node",
      connected: true,
      commands: ["computer.act", "screen.snapshot"],
      computerUse: capabilities(["screenshot", "scroll"]),
    },
  ]);
  await expectPrepared({ actions: ["screenshot", "scroll"] });
  const embedded = createContext();
  embedded.localEmbedded = true;
  await expectPrepared({ actions: ["screenshot", "scroll"] }, embedded);
});
