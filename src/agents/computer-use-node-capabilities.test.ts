import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { startComputerHostProcess } from "../gateway/desktop/computer-process.js";
import { createGatewayComputerService } from "../gateway/desktop/computer-service.js";
import { NodeRegistry } from "../gateway/node-registry.js";
import { makeClient, registerNodeSession } from "../gateway/node-registry.test-helpers.js";
import type { GatewayRequestContext } from "../gateway/server-methods/types.js";
import type { DevicePairingNodeSnapshot } from "../infra/device-pairing-read.types.js";
import { readDevicePairingNodeSnapshot } from "../infra/device-pairing-store-readonly.js";
import type {
  ComputerUseCapabilityDescriptor,
  ComputerUseV2ActionName,
} from "../plugins/computer-use-contract.js";
import { registerComputerUseProvider } from "../plugins/computer-use-registration.js";
import { createPluginRecord } from "../plugins/loader-records.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { withPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import { loadPairedComputerUseAvailabilityForSurface } from "./computer-use-node-capabilities.js";
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

function capabilities(actions: ComputerUseV2ActionName[]): ComputerUseCapabilityDescriptor {
  return {
    contractVersion: 2,
    provider: { id: "fixture", label: "Fixture computer", generation: "fixture-generation" },
    actions,
    targets: ["screen"],
    deliveryModes: ["foreground"],
    observations: ["image"],
    features: { recording: false, agentCursor: false, multiDisplay: false },
  };
}

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
const withContext = <T>(resolve: () => GatewayRequestContext | undefined, run: () => Promise<T>) =>
  withGatewayToolCallerIdentity(
    {
      agentId: "main",
      sessionKey: "agent:main:computer-discovery",
      gatewayContextResolver: resolve,
    },
    run,
  );

describe("paired computer tool preparation", () => {
  it("updates the advertised surface after the local node and pairing owners change", async () => {
    const context = createContext();
    await withContext(
      () => context,
      async () => {
        expect((await load())?.prepared?.actions).toEqual([]);
        connect(context, "paired-node", ["screenshot", "left_click"]);
        const connected = await load();
        expect(connected?.prepared?.actions).toEqual(["screenshot", "left_click"]);
        expect(connected?.prepared?.guidanceCapabilities?.provider.id).toBe("fixture");

        context.nodeRegistry.refreshRuntimePolicy({
          gateway: { nodes: { commands: { deny: ["computer.act"] } } },
        });
        expect((await load())?.prepared?.actions).toEqual([]);
        context.nodeRegistry.refreshRuntimePolicy({});
        expect((await load())?.prepared?.actions).toEqual(["screenshot", "left_click"]);

        pairing = { paired: [], bindings: new Map() };
        expect((await load())?.prepared?.actions).toEqual([]);
        connect(context, "paired-node", ["screenshot", "type"]);
        const reconnected = await load();
        expect(reconnected?.prepared?.actions).toEqual(["screenshot", "type"]);
        expect(reconnected?.cacheKey).not.toBe(connected?.cacheKey);
        context.nodeRegistry.unregister("connection-paired-node");
        expect((await load())?.prepared?.actions).toEqual([]);
      },
    );
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
    await withContext(
      () => context,
      async () => {
        const enabled = await load();
        expect(enabled?.prepared?.actions).toEqual(["screenshot", "left_click"]);
        expect(enabled?.prepared?.gateway).toMatchObject({ configured: true, available: false });
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
        expect((await load())?.prepared?.gateway).toMatchObject({
          configured: true,
          available: true,
        });
        active = false;
        expect((await load())?.prepared?.gateway).toMatchObject({
          configured: true,
          available: false,
        });

        publishProvider(["screenshot", "type"]);
        expect((await load())?.prepared?.actions).toEqual(["screenshot", "type"]);

        config = { plugins: { entries: { fixture: { enabled: false } } } };
        expect((await load())?.prepared).toMatchObject({
          actions: [],
          gateway: { configured: false, available: false },
        });
        config = { plugins: { entries: { fixture: { enabled: true } } } };
        expect((await load())?.prepared?.actions).toEqual(["screenshot", "type"]);
      },
    );
  });

  it("keeps inventory scoped to its admitted Gateway and rejects retired bindings locally", async () => {
    const first = createContext();
    const second = createContext();
    connect(first, "first-node", ["screenshot", "left_click"]);
    connect(second, "second-node", ["screenshot", "type"]);
    expect((await withContext(() => first, load))?.prepared?.actions).toEqual([
      "screenshot",
      "left_click",
    ]);
    expect((await withContext(() => second, load))?.prepared?.actions).toEqual([
      "screenshot",
      "type",
    ]);

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
    expect((await load())?.prepared?.actions).toEqual(["screenshot", "scroll"]);
    const embedded = createContext();
    embedded.localEmbedded = true;
    expect((await withContext(() => embedded, load))?.prepared?.actions).toEqual([
      "screenshot",
      "scroll",
    ]);
  });
});
