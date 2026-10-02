// Exercise Gateway session scoping through the real session-tab registry.
import { expectDefined } from "@openclaw/normalization-core";
import type { GatewayRequestHandlerOptions } from "openclaw/plugin-sdk/gateway-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBrowserNodeSessionTabRoute } from "../browser-node-proxy.js";
import { getOptionalBrowserStateRuntime } from "../browser-runtime-state.js";
import { resolveBrowserConfig, resolveProfile } from "../browser/config.js";
import type { createBrowserRouteDispatcher } from "../browser/routes/dispatcher.js";
import {
  closeTrackedBrowserTabsForSessions,
  filterTrackedSessionBrowserTabs,
  sweepTrackedBrowserTabs,
  trackSessionBrowserTab,
} from "../browser/session-tab-registry.js";
import { browserHandlers } from "./browser-request.js";

const {
  startBrowserControlServiceFromConfigMock,
  dispatchBrowserRouteMock,
  inspectBrowserDashboard,
} = vi.hoisted(() => ({
  startBrowserControlServiceFromConfigMock: vi.fn(),
  dispatchBrowserRouteMock: vi.fn(),
  inspectBrowserDashboard: vi.fn(),
}));

vi.mock("../control-service.js", () => ({
  startBrowserControlServiceFromConfig: startBrowserControlServiceFromConfigMock,
}));
vi.mock("../browser-control-state.js", () => ({ createBrowserControlContext: () => ({}) }));
vi.mock("../browser/routes/dispatcher.js", () => ({
  createBrowserRouteDispatcher: () => ({ dispatch: dispatchBrowserRouteMock }),
}));
vi.mock("../browser-dashboard.js", () => ({ inspectBrowserDashboard }));
vi.mock("../browser-proxy-upload.js", () => ({
  isBrowserProxyUploadRequest: () => false,
  prepareBrowserProxyUploadRequest: async ({ body }: { body: unknown }) => ({ body }),
}));
vi.mock("openclaw/plugin-sdk/runtime-config-snapshot", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/runtime-config-snapshot")>()),
  getRuntimeConfig: () => ({ gateway: { nodes: { browser: { mode: "auto" } } } }),
}));
vi.mock("openclaw/plugin-sdk/gateway-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/gateway-runtime")>()),
  isNodeCommandAllowed: () => ({ ok: true }),
  resolveNodeCommandAllowlist: () => [],
}));

type NodeInvoke = GatewayRequestHandlerOptions["context"]["nodeRegistry"]["invoke"];
type NodeInvokeResult = Awaited<ReturnType<NodeInvoke>>;
type TestNode = {
  nodeId: string;
  displayName?: string;
  caps: string[];
  commands: string[];
};

async function runBrowserRequest(
  params: Record<string, unknown>,
  invokeResult?: NodeInvokeResult,
  connectedNodes: TestNode[] = [],
  requester: Pick<GatewayRequestHandlerOptions, "hasCurrentClientAuthority"> = {},
) {
  const respond = vi.fn<GatewayRequestHandlerOptions["respond"]>();
  const nodeRegistry = {
    invoke: vi.fn<NodeInvoke>(async () => invokeResult ?? { ok: true }),
    listConnected: vi.fn(() =>
      connectedNodes.map(({ nodeId, displayName, caps, commands }) => ({
        nodeId,
        displayName,
        caps,
        commands,
        declaredCommands: commands,
      })),
    ),
  };
  await expectDefined(
    browserHandlers["browser.request"],
    "browser request handler",
  )({
    params,
    respond,
    context: { nodeRegistry },
    client: null,
    req: { type: "req", id: "scope-request", method: "browser.request" },
    isWebchatConnect: () => false,
    ...requester,
  });
  return { respond, nodeRegistry };
}

function firstRespondCall(respond: Awaited<ReturnType<typeof runBrowserRequest>>["respond"]) {
  return expectDefined(respond.mock.calls[0], "browser response");
}

function invokeParams(nodeRegistry: Awaited<ReturnType<typeof runBrowserRequest>>["nodeRegistry"]) {
  return expectDefined(nodeRegistry.invoke.mock.calls[0], "browser node invocation")[0];
}

describe("session tab scope", () => {
  const sessionKey = "agent:main:scope-a";
  const otherSessionKey = "agent:main:scope-b";
  const resolved = resolveBrowserConfig({ defaultProfile: "openclaw" });
  const profile = expectDefined(resolveProfile(resolved, "openclaw"), "host profile");
  type DispatchRequest = Parameters<ReturnType<typeof createBrowserRouteDispatcher>["dispatch"]>[0];

  function hostResponse(body: unknown, status = 200, afterDispatch?: () => void) {
    dispatchBrowserRouteMock.mockImplementation(async (request: DispatchRequest) => {
      await request.assertCurrent?.(profile);
      afterDispatch?.();
      return { status, body };
    });
  }

  beforeEach(() => {
    startBrowserControlServiceFromConfigMock.mockReset().mockResolvedValue({ resolved });
    dispatchBrowserRouteMock.mockReset();
    inspectBrowserDashboard.mockReset();
  });

  afterEach(async () => {
    await closeTrackedBrowserTabsForSessions({
      sessionKeys: [sessionKey, otherSessionKey],
      closeTab: async () => {},
    });
    vi.restoreAllMocks();
  });

  it("lists this session's owned and referenced host tabs while the dock lists all tabs", async () => {
    await trackSessionBrowserTab({ sessionKey, targetId: "owned", profile: "openclaw" });
    await trackSessionBrowserTab({
      sessionKey: otherSessionKey,
      targetId: "other-session",
      profile: "openclaw",
    });
    const owned = { targetId: "owned", tabId: "t0", url: "", blocked: true };
    const referenced = { targetId: "referenced", tabId: "t9" };
    const tabs = [
      owned,
      referenced,
      { targetId: "other-session" },
      { targetId: "outside-openclaw" },
      { targetId: "profile-collision", tabId: "t1" },
      { targetId: "node-collision", tabId: "t3" },
    ];
    hostResponse({ running: true, tabs });
    const { respond } = await runBrowserRequest({
      target: "host",
      method: "GET",
      path: "/tabs",
      tabScope: {
        sessionKey: ` ${sessionKey} `,
        referencedTabs: [
          { target: "host", profile: "openclaw", targetId: "referenced" },
          { target: "host", profile: "other-profile", targetId: "t1" },
          { target: "node", node: "node-1", profile: "openclaw", targetId: "t3" },
        ],
      },
    });
    expect(firstRespondCall(respond)).toEqual([true, { running: true, tabs: [owned, referenced] }]);
    const dock = await runBrowserRequest({ target: "host", method: "GET", path: "/tabs" });
    expect(firstRespondCall(dock.respond)).toEqual([true, { running: true, tabs }]);
  });

  it("makes a panel-opened tab visible to that session on its resolved profile", async () => {
    const opened = {
      targetId: "panel-opened",
      tabId: "t1",
      resolvedProfile: "openclaw",
    };
    hostResponse(opened);
    const result = await runBrowserRequest({
      target: "host",
      method: "POST",
      path: "/tabs/open",
      query: { profile: "requested-profile" },
      body: { url: "https://example.com" },
      tabScope: { sessionKey },
    });
    expect(firstRespondCall(result.respond)).toEqual([true, opened]);
    hostResponse({ running: true, tabs: [opened, { targetId: "untracked" }] });
    const listed = await runBrowserRequest({
      target: "host",
      method: "GET",
      path: "/tabs",
      query: { profile: "requested-profile" },
      tabScope: { sessionKey },
    });
    expect(firstRespondCall(listed.respond)).toEqual([true, { running: true, tabs: [opened] }]);
  });

  it("closes a newly opened tab on its resolved profile when cleanup tracking fails", async () => {
    expect(getOptionalBrowserStateRuntime()).toBeNull();
    hostResponse({
      targetId: "opened/target",
      resolvedProfile: "openclaw",
      ownership: {
        status: "durable",
        nativeTargetId: "opened/target",
        profileFingerprint: "test-profile-fingerprint",
        browserInstanceFingerprint: "test-browser-instance-fingerprint",
      },
    });
    const { respond } = await runBrowserRequest({
      target: "host",
      method: "POST",
      path: "/tabs/open",
      query: { profile: "requested-profile" },
      body: { url: "https://example.com" },
      tabScope: { sessionKey },
    });
    expect(firstRespondCall(respond)).toEqual([
      false,
      undefined,
      expect.objectContaining({
        message: expect.stringContaining("Browser state runtime not initialized"),
      }),
    ]);
    expect(dispatchBrowserRouteMock).toHaveBeenCalledTimes(2);
    expect(dispatchBrowserRouteMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        method: "DELETE",
        path: "/tabs/opened%2Ftarget",
        query: { profile: "openclaw", targetIdMode: "raw" },
        assertCurrent: expect.any(Function),
      }),
    );
  });

  it("tracks panel-opened node tabs on the node's resolved profile", async () => {
    const node = { nodeId: "node-1", caps: ["browser"], commands: ["browser.proxy"] };
    const opened = { targetId: "node-opened", tabId: "t1", resolvedProfile: "node-profile" };
    const request = {
      target: "node",
      node: "node-1",
      query: { profile: "requested-profile" },
      tabScope: { sessionKey },
    };
    const route = { status: "resolved", profile: "node-profile", driver: "openclaw" };
    const result = await runBrowserRequest(
      { ...request, method: "POST", path: "/tabs/open", body: { url: "https://example.com" } },
      { ok: true, payload: { result: opened, route } },
      [node],
    );
    expect(firstRespondCall(result.respond)).toEqual([true, opened]);
    const listed = await runBrowserRequest(
      { ...request, method: "GET", path: "/tabs" },
      {
        ok: true,
        payload: { result: { running: true, tabs: [opened, { targetId: "untracked" }] }, route },
      },
      [node],
    );
    expect(firstRespondCall(listed.respond)).toEqual([true, { running: true, tabs: [opened] }]);
  });

  it.each(
    ["/tabs/open", "/tabs/owned", "/navigate", "/tabs/focus", "/act", "/screenshot"].flatMap(
      (path) =>
        ["success", "failure", "stale"].map((outcome) => ({
          path,
          outcome,
          method: path === "/tabs/owned" ? "DELETE" : "POST",
        })),
    ),
  )(
    "updates ownership and activity only for current successful $path ($outcome)",
    async ({ path, method, outcome }) => {
      vi.spyOn(Date, "now").mockReturnValue(9_000);
      await trackSessionBrowserTab({
        sessionKey,
        targetId: "owned",
        profile: "openclaw",
        now: 1_000,
      });
      let current = true;
      hostResponse(
        { targetId: "opened", resolvedProfile: "openclaw" },
        outcome === "failure" ? 500 : 200,
        () => {
          current = outcome !== "stale";
        },
      );
      const { respond } = await runBrowserRequest(
        { target: "host", method, path, body: { targetId: "owned" }, tabScope: { sessionKey } },
        undefined,
        undefined,
        { hasCurrentClientAuthority: () => current },
      );
      expect(firstRespondCall(respond)[0]).toBe(outcome === "success");
      const succeeds = outcome === "success";
      const tracked = await filterTrackedSessionBrowserTabs({
        sessionKey,
        profile: "openclaw",
        tabs: [{ targetId: "owned" }, { targetId: "opened" }],
      });
      expect(tracked).toEqual([
        ...(path !== "/tabs/owned" || !succeeds ? [{ targetId: "owned" }] : []),
        ...(path === "/tabs/open" && succeeds ? [{ targetId: "opened" }] : []),
      ]);
      const closeTab = vi.fn(async () => {});
      await sweepTrackedBrowserTabs({
        now: 10_000,
        idleMs: 5_000,
        closeTab,
        sessionFilter: (key) => key === sessionKey,
      });
      const touched = succeeds && (path === "/navigate" || path === "/tabs/focus");
      expect(closeTab).toHaveBeenCalledTimes(
        touched || (path === "/tabs/owned" && succeeds) ? 0 : 1,
      );
    },
  );

  it("matches canonical node routes and profiles without forwarding tabScope to the proxy", async () => {
    const node = {
      nodeId: "canonical-node",
      displayName: "Work Browser",
      caps: ["browser"],
      commands: ["browser.proxy"],
    };
    await trackSessionBrowserTab({
      sessionKey,
      targetId: "node-owned",
      profile: "node-profile",
      route: createBrowserNodeSessionTabRoute(node),
    });
    await trackSessionBrowserTab({
      sessionKey,
      targetId: "other-node-owned",
      profile: "node-profile",
      route: createBrowserNodeSessionTabRoute({ ...node, nodeId: "other-node" }),
    });
    const owned = { targetId: "node-owned" };
    const referenced = { targetId: "node-referenced", tabId: "t1" };
    const tabs = [
      owned,
      referenced,
      { targetId: "other-node-owned" },
      { targetId: "wrong-profile", tabId: "t2" },
      { targetId: "wrong-node", tabId: "t3" },
    ];
    const { respond, nodeRegistry } = await runBrowserRequest(
      {
        target: "node",
        node: "Work Browser",
        method: "GET",
        path: "/tabs",
        query: { profile: "requested-profile" },
        tabScope: {
          sessionKey,
          referencedTabs: [
            { target: "node", node: "canonical-node", profile: "node-profile", targetId: "t1" },
            { target: "node", node: "canonical-node", profile: "other-profile", targetId: "t2" },
            { target: "node", node: "other-node", profile: "node-profile", targetId: "t3" },
          ],
        },
      },
      {
        ok: true,
        payload: {
          result: { running: true, tabs },
          route: { status: "resolved", profile: "node-profile", driver: "openclaw" },
        },
      },
      [node],
    );
    expect(firstRespondCall(respond)).toEqual([true, { running: true, tabs: [owned, referenced] }]);
    expect(invokeParams(nodeRegistry)).toMatchObject({ nodeId: "canonical-node" });
    expect(invokeParams(nodeRegistry).params).toEqual({
      method: "GET",
      path: "/tabs",
      query: { profile: "requested-profile" },
      body: undefined,
      upload: undefined,
      profile: "requested-profile",
      timeoutMs: expect.any(Number),
      errorEnvelope: "browser-v1",
    });
  });

  it.each([
    null,
    {},
    { sessionKey: " " },
    { sessionKey: "s".repeat(513) },
    { sessionKey, extra: true },
    {
      sessionKey,
      referencedTabs: Array.from({ length: 65 }, () => ({ target: "host", targetId: "t1" })),
    },
    { sessionKey, referencedTabs: [{ target: "sandbox", targetId: "t1" }] },
    { sessionKey, referencedTabs: [{ target: "host", node: "node-1", targetId: "t1" }] },
    { sessionKey, referencedTabs: [{ target: "host", profile: " ", targetId: "t1" }] },
    { sessionKey, referencedTabs: [{ target: "host", targetId: " " }] },
    { sessionKey, referencedTabs: [{ target: "node", node: " ", targetId: "t1" }] },
    { sessionKey, referencedTabs: [{ target: "host", targetId: "t1", extra: true }] },
  ])("rejects malformed tabScope before dispatch: %j", async (tabScope) => {
    const { respond, nodeRegistry } = await runBrowserRequest({
      method: "GET",
      path: "/tabs",
      tabScope,
    });
    expect(firstRespondCall(respond)).toEqual([
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    ]);
    expect(dispatchBrowserRouteMock).not.toHaveBeenCalled();
    expect(nodeRegistry.invoke).not.toHaveBeenCalled();
  });

  it.each([{ path: "/tabs", dashboard: { sessionKey, name: "board" } }, { path: "/dashboard" }])(
    "rejects mixing session tab scope with dashboard requests: %j",
    async (request) => {
      const { respond, nodeRegistry } = await runBrowserRequest({
        method: "GET",
        ...request,
        tabScope: { sessionKey },
      });
      expect(firstRespondCall(respond)).toEqual([
        false,
        undefined,
        expect.objectContaining({ code: "INVALID_REQUEST" }),
      ]);
      expect(inspectBrowserDashboard).not.toHaveBeenCalled();
      expect(dispatchBrowserRouteMock).not.toHaveBeenCalled();
      expect(nodeRegistry.invoke).not.toHaveBeenCalled();
    },
  );
});
