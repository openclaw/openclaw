import "./browser-tool.test-support.js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createBrowserTool } from "./browser-tool.js";
const {
  browserClientMocks: client,
  browserHostAvailabilityMocks: host,
  configMocks: config,
  gatewayMocks: gateway,
  nodesUtilsMocks: nodes,
  resetBrowserToolMocks,
} = await import("./browser-tool.test-support.js");

beforeEach(() => {
  resetBrowserToolMocks();
  host.isBrowserHostAvailable.mockReturnValue(true);
});
afterEach(() => {
  resetBrowserToolMocks();
  vi.unstubAllEnvs();
});

const desktop = {
  nodeId: "desktop",
  displayName: "Paired desktop",
  connected: true,
  commands: ["browser.proxy"],
};
const hostProfiles = [{ name: "user", driver: "existing-session", running: true }];
const denied = new Error("EPERM: operation not permitted, open DevToolsActivePort");
const execute = (input: Record<string, unknown>) => createBrowserTool().execute("test", input);

it("discovers a node without replaying a denied host attach or assuming the node profile", async () => {
  nodes.listNodes.mockResolvedValue([desktop]);
  client.browserProfiles.mockResolvedValueOnce(hostProfiles);
  client.browserTabs.mockRejectedValueOnce(denied);
  await expect(execute({ action: "tabs", profile: "user" })).rejects.toBe(denied);
  expect(gateway.callGatewayTool).not.toHaveBeenCalled();

  const discovery = await execute({ action: "profiles", target: "host" });
  expect(discovery.details).toMatchObject({
    profiles: hostProfiles,
    nodeRoutes: [{ target: "node", node: "desktop", label: "Paired desktop" }],
  });
  expect(gateway.callGatewayTool).not.toHaveBeenCalled();

  // The caller explicitly selects the candidate, then discovers that node's profiles.
  gateway.callGatewayTool.mockResolvedValueOnce({
    payload: { result: { profiles: [{ name: "chrome", driver: "extension" }] } },
  });
  const selected = await execute({ action: "profiles", target: "node", node: "desktop" });
  expect(selected.details).toHaveProperty("profiles", [{ name: "chrome", driver: "extension" }]);
  expect(gateway.callGatewayTool).toHaveBeenLastCalledWith(
    "node.invoke",
    { timeoutMs: expect.any(Number) },
    expect.objectContaining({
      nodeId: "desktop",
      command: "browser.proxy",
      params: expect.objectContaining({ method: "GET", path: "/profiles", profile: undefined }),
    }),
    { scopes: ["operator.admin"] },
  );
  expect(client.browserProfiles).toHaveBeenCalledTimes(1);

  const route = { target: "node", node: "desktop", profile: "chrome" };
  gateway.callGatewayTool.mockResolvedValueOnce({
    payload: {
      result: { running: true, tabs: [{ targetId: "NODE-TAB", url: "https://example.com/admin" }] },
    },
  });
  const tabs = await execute({ ...route, action: "tabs" });
  expect(tabs.details).toHaveProperty("tabs.0.targetId", "NODE-TAB");
  gateway.callGatewayTool.mockResolvedValueOnce({
    payload: {
      result: {
        ok: true,
        targetId: "NODE-TAB",
        url: "https://example.com/admin",
        format: "ai",
        snapshot: "Account: operator@example.com; role: admin",
      },
      route: { status: "resolved", profile: "chrome", driver: "extension" },
    },
  });
  const snapshot = await execute({ ...route, action: "snapshot", targetId: "NODE-TAB" });
  expect(snapshot.details).toMatchObject({ browserTab: { ...route, targetId: "NODE-TAB" } });
  expect(snapshot.content).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        type: "text",
        text: expect.stringContaining("operator@example.com"),
      }),
    ]),
  );
  expect(gateway.callGatewayTool).toHaveBeenLastCalledWith(
    "node.invoke",
    { timeoutMs: expect.any(Number) },
    expect.objectContaining({
      nodeId: "desktop",
      command: "browser.proxy",
      params: expect.objectContaining({ path: "/snapshot", profile: "chrome" }),
    }),
    { scopes: ["operator.admin"] },
  );
  expect(client.browserSnapshot).not.toHaveBeenCalled();
});

it.each(["empty", "offline", "unapproved", "disabled", "sandbox", "standalone", "failed"] as const)(
  "keeps host discovery useful when node discovery is %s",
  async (outcome) => {
    client.browserProfiles.mockResolvedValueOnce(hostProfiles);
    nodes.listNodes.mockResolvedValue(
      outcome === "offline"
        ? [{ ...desktop, connected: false }]
        : outcome === "unapproved"
          ? [{ ...desktop, caps: ["browser"], commands: [] }]
          : [],
    );
    if (outcome === "disabled") {
      config.loadConfig.mockReturnValue({
        browser: {},
        gateway: { nodes: { browser: { mode: "off" } } },
      });
    }
    if (outcome === "standalone") {
      gateway.hasGatewayToolRoutingContext.mockReturnValue(false);
      vi.stubEnv("OPENCLAW_GATEWAY_URL", "");
    }
    if (outcome === "failed") {
      nodes.listNodes.mockRejectedValueOnce(new Error("node.list unavailable"));
    }
    const result = await createBrowserTool(
      outcome === "sandbox"
        ? { allowHostControl: false, sandboxBridgeUrl: "http://127.0.0.1:18888" }
        : undefined,
    ).execute("test", { action: "profiles", target: outcome === "sandbox" ? "sandbox" : "host" });
    expect(result.details).toMatchObject({ profiles: hostProfiles, nodeRoutes: [] });
    if (["disabled", "sandbox", "standalone", "failed"].includes(outcome)) {
      expect(result.details).toHaveProperty("nodeRoutesUnavailable", expect.any(String));
    } else {
      expect(result.details).not.toHaveProperty("nodeRoutesUnavailable");
    }
    if (["disabled", "sandbox", "standalone"].includes(outcome)) {
      expect(nodes.listNodes).not.toHaveBeenCalled();
    }
    expect(gateway.callGatewayTool).not.toHaveBeenCalled();
  },
);

it("preserves cancellation instead of reporting no alternate routes", async () => {
  const controller = new AbortController();
  client.browserProfiles.mockResolvedValueOnce(hostProfiles);
  nodes.listNodes.mockImplementationOnce(async () => {
    controller.abort(denied);
    throw denied;
  });
  await expect(
    createBrowserTool().execute("test", { action: "profiles", target: "host" }, controller.signal),
  ).rejects.toBe(denied);
});
