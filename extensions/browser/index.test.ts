import { describe, expect, it, vi } from "vitest";
import { createTestPluginApi } from "../../test/helpers/plugins/plugin-api.js";
import type { OpenClawPluginApi } from "./runtime-api.js";

const runtimeApiMocks = vi.hoisted(() => ({
  createBrowserPluginService: vi.fn(() => ({ id: "browser-control", start: vi.fn() })),
  createBrowserTool: vi.fn(() => ({
    name: "browser",
    description: "browser",
    parameters: { type: "object", properties: {} },
    execute: vi.fn(),
  })),
  handleBrowserGatewayRequest: vi.fn(),
  registerBrowserCli: vi.fn(),
}));

vi.mock("./runtime-api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./runtime-api.js")>();
  return {
    ...actual,
    createBrowserPluginService: runtimeApiMocks.createBrowserPluginService,
    createBrowserTool: runtimeApiMocks.createBrowserTool,
    handleBrowserGatewayRequest: runtimeApiMocks.handleBrowserGatewayRequest,
    registerBrowserCli: runtimeApiMocks.registerBrowserCli,
  };
});

import browserPlugin from "./index.js";

function createApi() {
  const registerCli = vi.fn();
  const registerGatewayMethod = vi.fn();
  const registerService = vi.fn();
  const registerTool = vi.fn();
  const api = createTestPluginApi({
    id: "browser",
    name: "Browser",
    source: "test",
    config: {},
    runtime: {} as OpenClawPluginApi["runtime"],
    registerCli,
    registerGatewayMethod,
    registerService,
    registerTool,
  }) as OpenClawPluginApi;
  return { api, registerCli, registerGatewayMethod, registerService, registerTool };
}

describe("browser plugin", () => {
  it("registers browser tool, cli, gateway method, and service ownership", () => {
    const { api, registerCli, registerGatewayMethod, registerService, registerTool } = createApi();
    browserPlugin.register(api);

    expect(registerTool).toHaveBeenCalledTimes(1);
    expect(registerCli).toHaveBeenCalledWith(expect.any(Function), { commands: ["browser"] });
    expect(registerGatewayMethod).toHaveBeenCalledWith(
      "browser.request",
      runtimeApiMocks.handleBrowserGatewayRequest,
      { scope: "operator.write" },
    );
    expect(runtimeApiMocks.createBrowserPluginService).toHaveBeenCalledTimes(1);
    expect(registerService).toHaveBeenCalledWith(
      runtimeApiMocks.createBrowserPluginService.mock.results[0]?.value,
    );
  });

  it("forwards per-session browser options into the tool factory", () => {
    const { api, registerTool } = createApi();
    browserPlugin.register(api);

    const tool = registerTool.mock.calls[0]?.[0];
    if (typeof tool !== "function") {
      throw new Error("expected browser plugin to register a tool factory");
    }

    tool({
      sessionKey: "agent:main:webchat:direct:123",
      browser: {
        sandboxBridgeUrl: "http://127.0.0.1:9999",
        allowHostControl: true,
      },
    });

    expect(runtimeApiMocks.createBrowserTool).toHaveBeenCalledWith({
      sandboxBridgeUrl: "http://127.0.0.1:9999",
      allowHostControl: true,
      agentSessionKey: "agent:main:webchat:direct:123",
    });
  });
});
