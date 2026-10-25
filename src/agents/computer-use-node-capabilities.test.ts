import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createGatewayComputerService } from "../gateway/desktop/computer-service.js";
import { computerCapabilities } from "../gateway/desktop/computer.test-support.js";
import { NodeRegistry } from "../gateway/node-registry.js";
import { makeClient, registerNodeSession } from "../gateway/node-registry.test-helpers.js";
import type { GatewayRequestContext } from "../gateway/server-methods/types.js";
import type { DevicePairingNodeSnapshot } from "../infra/device-pairing-read.types.js";
import { readDevicePairingNodeSnapshot } from "../infra/device-pairing-store-readonly.js";
import type { ComputerUseV2ActionName } from "../plugins/computer-use-contract.js";
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
  vi.restoreAllMocks();
  for (const registry of registries.splice(0)) {
    for (const session of registry.listConnected()) {
      registry.unregister(session.connId);
    }
  }
  for (const service of services.splice(0)) {
    await service.close();
  }
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

it("projects fresh local computer owner publications", async () => {
  const service = createGatewayComputerService({
    getConfig: () => ({}),
    getPluginRegistry: createEmptyPluginRegistry,
  });
  services.push(service);
  const status = vi.spyOn(service, "status");
  const context = createContext(service);
  for (const [configured, available, actions] of [
    [true, false, ["screenshot", "left_click"]],
    [true, true, ["screenshot", "left_click"]],
    [true, false, ["screenshot", "type"]],
    [false, false, []],
    [true, false, ["screenshot", "type"]],
  ] satisfies Array<[boolean, boolean, ComputerUseV2ActionName[]]>) {
    status.mockResolvedValue({
      configured,
      available,
      computerUse: capabilities(actions),
    });
    await expectPrepared({ actions, gateway: { configured, available } }, context);
  }
  for (const [options] of status.mock.calls) {
    expect(options?.probe).toBe(false);
  }
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
