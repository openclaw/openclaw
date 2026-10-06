import "./browser-tool.test-support.js";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type {
  OpenClawPluginApi,
  OpenClawPluginToolContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { beforeEach, expect, it, vi } from "vitest";
import { registerBrowserPlugin } from "../plugin-registration.js";
import { createBrowserTool } from "./browser-tool.js";
const {
  browserClientMocks: client,
  browserHostAvailabilityMocks: host,
  configMocks: config,
  gatewayMocks: gateway,
  nodesUtilsMocks: nodes,
  resetBrowserToolMocks,
} = await import("./browser-tool.test-support.js");

vi.mock("../register.runtime.js", () => ({
  createBrowserTool,
  hasBrowserNodeHostWork: () => false,
}));

beforeEach(resetBrowserToolMocks);

function registeredTool(context: OpenClawPluginToolContext) {
  const registerTool = vi.fn<OpenClawPluginApi["registerTool"]>();
  registerBrowserPlugin(
    createTestPluginApi({
      registerTool,
      runtime: {
        state: { openKeyedStore: () => ({ register: vi.fn(), entries: vi.fn() }) },
      } as unknown as OpenClawPluginApi["runtime"],
    }),
  );
  const factory = registerTool.mock.calls[0]?.[0];
  if (typeof factory !== "function") {
    throw new Error("expected registered browser factory");
  }
  const tool = factory(context);
  if (!tool || Array.isArray(tool)) {
    throw new Error("expected one registered browser tool");
  }
  return tool;
}

type Policy = NonNullable<NonNullable<OpenClawConfig["gateway"]>["nodes"]>["browser"];
const pin = { mode: "manual", node: "node-1" } as const;
const bridge = "http://127.0.0.1:9999";

it.each<{
  name: string;
  policy?: Policy;
  browser?: OpenClawPluginToolContext["browser"];
  route: "host" | "node" | "sandbox" | "blocked";
  guidance: string;
}>([
  {
    name: "manual pin",
    policy: pin,
    route: "node",
    guidance: "Default: configured browser node.",
  },
  {
    name: "auto pin",
    policy: { mode: "auto", node: " node-1 " },
    route: "node",
    guidance: "Default: configured browser node.",
  },
  {
    name: "automatic node selection",
    route: "node",
    guidance: "Default: host.",
  },
  {
    name: "manual without pin",
    policy: { mode: "manual" },
    route: "host",
    guidance: "Default: host.",
  },
  {
    name: "off with pin",
    policy: { mode: "off", node: "node-1" },
    route: "host",
    guidance: "Default: host.",
  },
  {
    name: "sandbox before pin with denied host control",
    policy: pin,
    browser: { sandboxBridgeUrl: bridge, allowHostControl: false },
    route: "sandbox",
    guidance: "Default: sandbox.",
  },
  {
    name: "denied host control without sandbox",
    policy: pin,
    browser: { allowHostControl: false },
    route: "blocked",
    guidance: "Host target blocked by policy.",
  },
])("aligns registered guidance with dispatch for $name", async (scenario) => {
  const runtimeConfig = { browser: {}, gateway: { nodes: { browser: scenario.policy } } };
  config.loadConfig.mockReturnValue(runtimeConfig);
  host.isBrowserHostAvailable.mockReturnValue(Boolean(scenario.policy?.node));
  nodes.listNodes.mockResolvedValue([
    { nodeId: "node-1", connected: true, caps: ["browser"], commands: ["browser.proxy"] },
  ]);
  const tool = registeredTool({
    browser: scenario.browser,
    config: { gateway: { nodes: { browser: { mode: "off" } } } },
    getRuntimeConfig: () => runtimeConfig,
  });
  const execution = tool.execute("routing-proof", { action: "status" });
  if (scenario.route === "blocked") {
    await expect(execution).rejects.toThrow("Host browser control is disabled");
  } else {
    await execution;
  }
  if (scenario.route === "node") {
    expect(gateway.callGatewayTool).toHaveBeenCalledWith(
      "node.invoke",
      expect.anything(),
      expect.objectContaining({ nodeId: "node-1" }),
      expect.anything(),
    );
    expect(client.browserStatus).not.toHaveBeenCalled();
  } else {
    expect(gateway.callGatewayTool).not.toHaveBeenCalled();
    if (scenario.route === "blocked") {
      expect(client.browserStatus).not.toHaveBeenCalled();
    } else {
      expect(client.browserStatus).toHaveBeenCalledWith(
        scenario.route === "sandbox" ? bridge : undefined,
        { profile: undefined },
      );
    }
  }
  expect(tool.description).toContain(scenario.guidance);
  if (scenario.policy?.node && scenario.policy.mode !== "off" && !scenario.browser) {
    expect(tool.description).not.toContain("Prefer the host browser");
    expect(tool.description).toContain("it bypasses configured node routing");
    expect(tool.description).toContain("report the routing error rather than switching to host");
  }
});
