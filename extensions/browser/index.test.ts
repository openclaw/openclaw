import assert from "node:assert/strict";
import type { OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { beforeAll, beforeEach, expect, it, vi } from "vitest";
import {
  browserPluginNodeHostCommands,
  browserSecurityAuditCollectors,
  registerBrowserPlugin,
} from "./plugin-registration.js";
import type { OpenClawPluginApi } from "./runtime-api.js";
import setupPlugin from "./setup-api.js";
import { BrowserToolOutputSchema } from "./src/browser-tool.schema.js";

const tabBinding = { kind: "tab", tabId: 7, target: "host", profile: "chrome", targetId: "t7" };

const runtimeApiMocks = vi.hoisted(() => ({
  createBrowserTool: vi.fn(() => ({
    execute: vi.fn(async () => ({ type: "json", value: { ok: true } })),
  })),
  collectBrowserSecurityAuditFindings: vi.fn(() => []),
  runBrowserProxyCommand: vi.fn(async () => "ok"),
}));

vi.mock("./register.runtime.js", async () => {
  const actual =
    await vi.importActual<typeof import("./register.runtime.js")>("./register.runtime.js");
  return {
    ...actual,
    collectBrowserSecurityAuditFindings: runtimeApiMocks.collectBrowserSecurityAuditFindings,
    createBrowserTool: runtimeApiMocks.createBrowserTool,
    runBrowserProxyCommand: runtimeApiMocks.runBrowserProxyCommand,
  };
});

beforeAll(async () => {
  await import("./register.runtime.js");
});

beforeEach(() => vi.clearAllMocks());

function createApi() {
  const hooks = {
    registerCli: vi.fn(),
    registerGatewayMethod: vi.fn<OpenClawPluginApi["registerGatewayMethod"]>(),
    registerTool: vi.fn<OpenClawPluginApi["registerTool"]>(),
  };
  const openKeyedStore = vi.fn(() => ({
    entries: vi.fn(async () => []),
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

type ToolProperty = {
  enum?: string[];
  properties?: Record<string, { enum?: string[] }>;
};
function toolProperties(tool: ReturnType<typeof createTool>) {
  return (tool.parameters as { properties: Record<string, ToolProperty> }).properties;
}

function createTool(context: OpenClawPluginToolContext) {
  const { api, registerTool } = createApi();
  registerBrowserPlugin(api);
  const factory = registerTool.mock.calls[0]?.[0];
  assert(typeof factory === "function", "expected browser plugin to register a tool factory");
  const tool = factory(context);
  assert(tool && !Array.isArray(tool), "expected browser plugin to return a single tool");
  return tool;
}

it("initializes the durable tab registry without loading browser control or Gateway runtime", () => {
  const { api, openKeyedStore, registerCli } = createApi();
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
  const cli = registerCli.mock.calls[0];
  expect(cli?.[0]).toBeTypeOf("function");
  expect(cli?.[1]).toMatchObject({
    commands: ["browser"],
    descriptors: [{ name: "browser", hasSubcommands: true, machineOutput: expect.any(Function) }],
  });
});

it("requires admin authority for the browser request Gateway method", () => {
  const { api, registerGatewayMethod } = createApi();
  registerBrowserPlugin(api);
  const registration = registerGatewayMethod.mock.calls.find(
    ([name]) => name === "browser.request",
  );
  expect(registration).toBeDefined();
  expect(registration?.[2]).toEqual({ scope: "operator.admin" });
});

it("makes node commands unavailable when browser or proxy control is disabled", () => {
  const isAvailable = (config: OpenClawPluginApi["config"]) =>
    browserPluginNodeHostCommands[0]?.isAvailable?.({ config, env: {} });
  expect(isAvailable({})).toBe(true);
  expect(isAvailable({ browser: { enabled: false } })).toBe(false);
  expect(isAvailable({ nodeHost: { browserProxy: { enabled: false } } })).toBe(false);
});

it.each(["direct", "group"] as const)(
  "lazily creates a tool with %s media scope",
  async (chatType) => {
    const sessionKey = `agent:main:telegram:${chatType}:chat-123`;
    const tool = createTool({
      sessionKey,
      agentId: "main",
      agentDir: "/tmp/agent",
      workspaceDir: "/tmp/workspace",
      browser: { sandboxBridgeUrl: "http://127.0.0.1:9999", allowHostControl: true },
      activeModel: { provider: "openai", modelId: "gpt-5.5" },
      ...(chatType === "direct"
        ? { deliveryContext: { channel: "telegram" } }
        : { messageChannel: "telegram" }),
    });
    expect(tool).toMatchObject({ name: "browser", resultContentSource: "network" });
    expect(tool.outputSchema).toBe(BrowserToolOutputSchema);
    expect(runtimeApiMocks.createBrowserTool).not.toHaveBeenCalled();
    await tool.execute("call-1", { action: "status" });
    expect(runtimeApiMocks.createBrowserTool).toHaveBeenCalledWith(
      expect.objectContaining({
        activeModel: { provider: "openai", model: "gpt-5.5" },
        mediaScope: { sessionKey, channel: "telegram", chatType },
      }),
    );
  },
);

it("describes and freezes only effective tab-bound actions when evaluation is disabled", async () => {
  const tool = createTool({
    runtimeConfig: { browser: { evaluateEnabled: false } },
    toolBindings: { browser: tabBinding },
  });
  const { action, kind, request, ...properties } = toolProperties(tool);
  assert(action && kind && request, "expected action, kind, and request schemas");

  expect(action.enum).toContain("snapshot");
  expect(action.enum).not.toContain("open");
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

it("carries prepared loopback capability and live authority into the browser tool", async () => {
  const assertInvocationCurrent = vi.fn();
  const assertLocalLoopbackCurrent = vi.fn();
  const tool = createTool({
    browser: { allowLocalLoopback: true, assertLocalLoopbackCurrent },
    assertInvocationCurrent,
  });
  await tool.execute("preview", { action: "status" });
  expect(runtimeApiMocks.createBrowserTool).toHaveBeenCalledWith(
    expect.objectContaining({
      allowLocalLoopback: true,
      assertLocalLoopbackCurrent,
      assertInvocationCurrent,
    }),
  );
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
  for (const action of "pdf download waitfordownload requests errors text emulate".split(" ")) {
    expect(properties.action?.enum).not.toContain(action);
  }
  expect(properties.action?.enum).toEqual(expect.arrayContaining(["snapshot", "screenshot"]));
  expect(properties.kind?.enum).not.toContain("batch");
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
