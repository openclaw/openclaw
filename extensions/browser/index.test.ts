import assert from "node:assert/strict";
import type {
  OpenClawPluginService,
  OpenClawPluginToolContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { createPluginRecord, createPluginRegistry } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import {
  browserPluginNodeHostCommands,
  browserPluginReload,
  browserSecurityAuditCollectors,
  registerBrowserPlugin,
} from "./plugin-registration.js";
import type { OpenClawPluginApi } from "./runtime-api.js";
import setupPlugin from "./setup-api.js";
import { BrowserToolOutputSchema } from "./src/browser-tool.schema.js";

const sessionKey = "agent:main:webchat:direct:123";
const tabBinding = {
  kind: "tab",
  tabId: 7,
  target: "host",
  profile: "chrome",
  targetId: "target-7",
};
const serviceContext = {
  config: {},
  stateDir: "/tmp/openclaw",
  logger: createTestPluginApi().logger,
};

const runtimeApiMocks = vi.hoisted(() => ({
  createBrowserPluginService: vi.fn(() => ({ id: "browser-control", start: vi.fn() })),
  createBrowserTool: vi.fn(() => ({
    execute: vi.fn(async () => ({ type: "json", value: { ok: true } })),
  })),
  collectBrowserSecurityAuditFindings: vi.fn(() => []),
  handleBrowserGatewayRequest: vi.fn(),
  registerBrowserCli: vi.fn(),
  runBrowserProxyCommand: vi.fn(async () => "ok"),
  stopBrowserControlService: vi.fn(async () => undefined),
}));

vi.mock("./register.runtime.js", async () => {
  const actual =
    await vi.importActual<typeof import("./register.runtime.js")>("./register.runtime.js");
  return {
    ...actual,
    collectBrowserSecurityAuditFindings: runtimeApiMocks.collectBrowserSecurityAuditFindings,
    createBrowserPluginService: runtimeApiMocks.createBrowserPluginService,
    createBrowserTool: runtimeApiMocks.createBrowserTool,
    handleBrowserGatewayRequest: runtimeApiMocks.handleBrowserGatewayRequest,
    runBrowserProxyCommand: runtimeApiMocks.runBrowserProxyCommand,
  };
});

vi.mock("./src/cli/browser-cli.js", () => ({
  registerBrowserCli: runtimeApiMocks.registerBrowserCli,
}));

vi.mock("./src/control-service.js", () => ({
  stopBrowserControlService: runtimeApiMocks.stopBrowserControlService,
}));

beforeAll(async () => {
  await import("./register.runtime.js");
});

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.unstubAllEnvs());

function createApi() {
  const hooks = {
    registerCli: vi.fn(),
    registerGatewayMethod: vi.fn(),
    registerService: vi.fn(),
    registerTool: vi.fn<OpenClawPluginApi["registerTool"]>(),
  };
  const openKeyedStore = vi.fn(() => ({
    register: vi.fn(async () => undefined),
    registerIfAbsent: vi.fn(async () => true),
    lookup: vi.fn(async () => undefined),
    consume: vi.fn(async () => undefined),
    delete: vi.fn(async () => false),
    entries: vi.fn(async () => []),
    clear: vi.fn(async () => undefined),
  }));
  const api = createTestPluginApi({
    id: "browser",
    rootDir: "/plugins/browser",
    runtime: {
      state: { openKeyedStore },
    } as unknown as OpenClawPluginApi["runtime"],
    ...hooks,
  });
  return { api, openKeyedStore, ...hooks };
}

function createService() {
  const { api, registerService } = createApi();
  registerBrowserPlugin(api);
  return mockCallArg(registerService) as OpenClawPluginService;
}

type ToolProperty = {
  description?: string;
  enum?: string[];
  properties?: Record<string, { enum?: string[] }>;
};
function toolProperties(tool: ReturnType<typeof createTool>) {
  return (tool.parameters as { properties: Record<string, ToolProperty> }).properties;
}

function createTool(context: OpenClawPluginToolContext, registration = createApi()) {
  const { api, registerTool } = registration;
  registerBrowserPlugin(api);
  const factory = registerTool.mock.calls[0]?.[0];
  assert(typeof factory === "function", "expected browser plugin to register a tool factory");
  const tool = factory(context);
  assert(tool && !Array.isArray(tool), "expected browser plugin to return a single tool");
  return tool;
}

function mockCallArg(mock: { mock: { calls: unknown[][] } }, index = 0, argIndex = 0): unknown {
  const call = mock.mock.calls.at(index);
  assert(call, `expected mock call ${index}`);
  return call[argIndex];
}

it("initializes the durable tab registry without loading browser control or Gateway runtime", () => {
  const { api, openKeyedStore } = createApi();
  Object.defineProperty(api.runtime, "gateway", {
    get() {
      throw new Error("Gateway runtime must stay lazy during Browser registration");
    },
  });
  registerBrowserPlugin(api);

  expect(openKeyedStore).toHaveBeenCalledWith({
    namespace: "browser.session-tabs",
    maxEntries: 5_000,
    overflowPolicy: "reject-new",
  });
  for (const store of openKeyedStore.mock.results) {
    expect(store.value.entries).not.toHaveBeenCalled();
  }
  expect(runtimeApiMocks.createBrowserPluginService).not.toHaveBeenCalled();
});

it("exposes static browser metadata on the plugin definition", () => {
  const isAvailable = (config: OpenClawPluginApi["config"]) =>
    browserPluginNodeHostCommands[0]?.isAvailable?.({ config, env: {} });
  expect(browserPluginReload).toEqual({
    restartPrefixes: ["browser"],
    hotPrefixes:
      "profiles defaultProfile headless executablePath attachOnly cdpUrl noSandbox extraArgs snapshotDefaults tabCleanup allowSystemProfileImport"
        .split(" ")
        .map((key) => `browser.${key}`),
  });
  expect(browserPluginNodeHostCommands.map((entry) => entry.command)).toEqual([
    "browser.proxy",
    "browser.proxy.upload.v1",
  ]);
  for (const command of browserPluginNodeHostCommands) {
    expect(command).toMatchObject({ cap: "browser", handle: expect.any(Function) });
  }
  expect(isAvailable({})).toBe(true);
  expect(isAvailable({ browser: { enabled: false } })).toBe(false);
  expect(isAvailable({ nodeHost: { browserProxy: { enabled: false } } })).toBe(false);
  expect(typeof browserPluginNodeHostCommands[1]?.watchAvailability).toBe("function");
  expect(browserSecurityAuditCollectors).toHaveLength(1);
});

it("keeps browser tool registration synchronous while loading runtime on execute", async () => {
  const registration = createApi();
  const { api, registerTool } = registration;
  const record = createPluginRecord({ id: "browser", contracts: { tools: ["browser"] } });
  const registry = createPluginRegistry({
    runtime: api.runtime,
    logger: api.logger,
    activateGlobalSideEffects: false,
  });
  registerTool.mockImplementation((tool, options) => registry.registerTool(record, tool, options));
  const tool = createTool(
    {
      sessionKey,
      agentId: "main",
      agentDir: "/tmp/agent",
      workspaceDir: "/tmp/workspace",
      activeModel: { provider: "openai", modelId: "gpt-5.5" },
      deliveryContext: { channel: "telegram" },
      browser: {
        sandboxBridgeUrl: "http://127.0.0.1:9999",
        allowHostControl: true,
      },
    },
    registration,
  );

  expect(record.toolNames).toEqual(["browser"]);
  expect(registry.registry.tools).toEqual([
    expect.objectContaining({ names: ["browser"], optional: false }),
  ]);
  expect(tool).toMatchObject({ name: "browser", resultContentSource: "network" });
  expect(tool.description).toContain("action=profiles");
  expect(tool.description).not.toContain('profile="user"');
  expect(tool.outputSchema).toBe(BrowserToolOutputSchema);
  const properties = toolProperties(tool);
  expect(properties.actions?.description).toContain("batch");
  expect(properties.doubleClick?.description).toContain("clickCoords");
  expect(properties.labels?.description).toContain("snapshot");
  expect(runtimeApiMocks.createBrowserTool).not.toHaveBeenCalled();
  await tool.execute("call-1", { action: "status" });
  expect(runtimeApiMocks.createBrowserTool).toHaveBeenCalledWith({
    sandboxBridgeUrl: "http://127.0.0.1:9999",
    allowHostControl: true,
    agentSessionKey: sessionKey,
    agentId: "main",
    agentDir: "/tmp/agent",
    workspaceDir: "/tmp/workspace",
    activeModel: { provider: "openai", model: "gpt-5.5" },
    mediaScope: { sessionKey, channel: "telegram", chatType: "direct" },
    toolCapabilities: expect.any(Object),
  });
});

it("describes and freezes only effective tab-bound actions when evaluation is disabled", async () => {
  const tool = createTool({
    runtimeConfig: { browser: { evaluateEnabled: false } },
    toolBindings: { browser: tabBinding },
  });
  const { action, kind, request, ...properties } = toolProperties(tool);
  assert(action && kind && request, "expected action, kind, and request schemas");

  expect(action.enum).toEqual(
    "act close console requests errors text emulate dialog download focus navigate pdf screenshot snapshot tabs upload waitfordownload".split(
      " ",
    ),
  );
  expect(kind.enum).not.toContain("evaluate");
  expect(request.properties?.kind?.enum).not.toContain("evaluate");
  expect(properties).not.toHaveProperty("fn");
  expect(request.properties).not.toHaveProperty("fn");
  expect(tool.description).not.toContain("action=profiles");
  expect(tool.description).not.toContain("target selects browser location");
  expect(tool.description).not.toContain("act:evaluate");

  await tool.execute("call-1", { action: "snapshot" });
  expect(runtimeApiMocks.createBrowserTool).toHaveBeenCalledWith({
    runToolBinding: tabBinding,
    toolCapabilities: expect.objectContaining({ tabBound: true }),
  });
});

it("omits unsupported actions for a host-bound existing-session profile", () => {
  const tool = createTool({
    runtimeConfig: {
      browser: {
        profiles: { user: { driver: "existing-session", attachOnly: true } },
      },
    },
    toolBindings: { browser: { ...tabBinding, profile: "user" } },
  });
  const properties = toolProperties(tool);
  assert(properties.action && properties.kind, "expected action and kind schemas");
  for (const action of "pdf download waitfordownload requests errors text emulate".split(" ")) {
    expect(properties.action.enum).not.toContain(action);
  }
  expect(properties).toMatchObject({
    action: { enum: expect.arrayContaining(["snapshot", "screenshot"]) },
  });
  expect(properties.actions?.description).toBeUndefined();
  expect(properties.stopOnError?.description).toBeUndefined();
  expect(properties.kind.enum).not.toContain("batch");
});

it("rejects malformed run bindings before creating the lazy browser tool", () => {
  expect(() => createTool({ toolBindings: { browser: { kind: "tab" } } })).toThrow(
    "invalid browser run binding",
  );
});

it("derives group chat type for browser media scope", async () => {
  const groupSessionKey = "agent:main:telegram:group:chat-123";
  const tool = createTool({
    sessionKey: groupSessionKey,
    messageChannel: "telegram",
  });

  await tool.execute("call-1", { action: "status" });
  expect(runtimeApiMocks.createBrowserTool).toHaveBeenCalledWith({
    agentSessionKey: groupSessionKey,
    mediaScope: { sessionKey: groupSessionKey, channel: "telegram", chatType: "group" },
    toolCapabilities: expect.any(Object),
  });
});

it("registers CLI descriptors and lazy-loads the lightweight browser CLI", async () => {
  const { api, registerCli } = createApi();
  registerBrowserPlugin(api);

  expect(registerCli).toHaveBeenCalledTimes(1);
  const registrar = mockCallArg(registerCli) as (params: { program: never }) => unknown;
  expect(mockCallArg(registerCli, 0, 1)).toEqual({
    commands: ["browser"],
    descriptors: [
      {
        name: "browser",
        description: "Manage OpenClaw's dedicated browser (Chrome/Chromium)",
        hasSubcommands: true,
        machineOutput: expect.any(Function),
      },
    ],
  });
  await registrar({ program: {} as never });
  expect(runtimeApiMocks.registerBrowserCli).toHaveBeenCalledWith(
    {},
    process.argv,
    "/plugins/browser",
  );
});

it("registers browser.request as an admin gateway method and lazy-loads handler", async () => {
  const { api, registerGatewayMethod } = createApi();
  registerBrowserPlugin(api);

  expect(registerGatewayMethod).toHaveBeenCalledTimes(2);
  expect(mockCallArg(registerGatewayMethod)).toBe("browser.request");
  const handler = mockCallArg(registerGatewayMethod, 0, 1) as (request: {
    method: string;
  }) => unknown;
  expect(mockCallArg(registerGatewayMethod, 0, 2)).toEqual({
    scope: "operator.admin",
  });
  await handler({ method: "browser.request" });
  expect(runtimeApiMocks.handleBrowserGatewayRequest).toHaveBeenCalledWith({
    method: "browser.request",
  });
});

it("lazy-loads node host and audit runtime handlers", async () => {
  const abortController = new AbortController();
  await expect(browserPluginNodeHostCommands[0]?.handle("{}")).resolves.toBe("ok");
  await expect(
    browserPluginNodeHostCommands[1]?.handle("{}", undefined, {
      sendNodeEvent: vi.fn(),
      signal: abortController.signal,
    }),
  ).resolves.toBe("ok");
  expect(runtimeApiMocks.runBrowserProxyCommand.mock.calls).toEqual([
    ["{}", "browser.proxy", undefined],
    ["{}", "browser.proxy.upload.v1", abortController.signal],
  ]);

  await expect(browserSecurityAuditCollectors[0]?.({} as never)).resolves.toStrictEqual([]);
  expect(runtimeApiMocks.collectBrowserSecurityAuditFindings).toHaveBeenCalled();
});

it("registers a lazy browser control service", async () => {
  const service = createService();
  expect(service).toMatchObject({
    id: "browser-control",
    start: expect.any(Function),
    stop: expect.any(Function),
  });
  expect(runtimeApiMocks.createBrowserPluginService).not.toHaveBeenCalled();

  await service.start(serviceContext);
  expect(runtimeApiMocks.createBrowserPluginService).not.toHaveBeenCalled();

  await service.stop!(serviceContext);
  expect(runtimeApiMocks.stopBrowserControlService).toHaveBeenCalledOnce();
});

it("eager-loads the browser control service when explicitly requested", async () => {
  vi.stubEnv("OPENCLAW_EAGER_BROWSER_CONTROL_SERVER", "1");
  await createService().start(serviceContext);
  expect(runtimeApiMocks.createBrowserPluginService).toHaveBeenCalledOnce();
});

it("declares setup auto-enable reasons for browser config surfaces", () => {
  const registerAutoEnableProbe = vi.fn<OpenClawPluginApi["registerAutoEnableProbe"]>();
  setupPlugin.register(createTestPluginApi({ registerAutoEnableProbe }));
  const probe = registerAutoEnableProbe.mock.calls[0]?.[0];
  assert(probe, "expected browser auto-enable probe");
  const result = (config: OpenClawPluginApi["config"]) => probe({ config, env: {} });
  expect(result({ browser: { defaultProfile: "openclaw" } })).toBe("browser configured");
  expect(result({ tools: { alsoAllow: ["browser"] } })).toBe("browser tool referenced");
  expect(result({ agents: { entries: { reviewer: { tools: { allow: ["browser"] } } } } })).toBe(
    "browser tool referenced",
  );
  expect(result({ browser: { defaultProfile: "openclaw", enabled: false } })).toBeNull();
});
