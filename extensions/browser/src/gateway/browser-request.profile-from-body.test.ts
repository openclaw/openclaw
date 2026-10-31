import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBrowserNodeSessionTabRoute } from "../browser-node-proxy.js";
import { resolveBrowserConfig, resolveProfile } from "../browser/config.js";
import type { createBrowserRouteDispatcher } from "../browser/routes/dispatcher.js";
import {
  closeTrackedBrowserTabsForSessions,
  filterTrackedSessionBrowserTabs,
  sweepTrackedBrowserTabs,
  trackSessionBrowserTab,
} from "../browser/session-tab-registry.js";

const m = vi.hoisted(() => ({
  config: vi.fn(),
  allowed: vi.fn(),
  start: vi.fn<() => Promise<boolean | { resolved: ReturnType<typeof resolveBrowserConfig> }>>(),
  dispatch: vi.fn(),
  hostAvailable: vi.fn((_config: unknown, _profileName?: string) => false),
  inspect: vi.fn(),
  prepareUpload: vi.fn(),
}));
vi.mock("../browser-host-availability.js", () => ({ isBrowserHostAvailable: m.hostAvailable }));
// mock-isolation: Dashboard admission uses synthetic state, not the persistent dashboard owner.
vi.mock("../browser-dashboard.js", () => ({
  inspectBrowserDashboard: m.inspect,
  assertBrowserDashboardTargetCurrent: async () => {},
}));
vi.mock("../control-service.js", () => ({ startBrowserControlServiceFromConfig: m.start }));
vi.mock("../browser-control-state.js", () => ({
  createBrowserControlContext: () => ({ control: true }),
}));
vi.mock("../browser/routes/dispatcher.js", () => ({
  createBrowserRouteDispatcher: () => ({ dispatch: m.dispatch }),
}));
vi.mock("../browser-proxy-upload.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../browser-proxy-upload.js")>()),
  prepareBrowserProxyUploadRequest: m.prepareUpload,
}));
vi.mock("openclaw/plugin-sdk/runtime-config-snapshot", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/runtime-config-snapshot")>()),
  readRuntimeConfig: m.config,
  loadConfig: m.config,
}));
vi.mock("openclaw/plugin-sdk/gateway-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/gateway-runtime")>()),
  isNodeCommandAllowed: m.allowed,
  resolveNodeCommandAllowlist: () => [],
}));

import { browserHandlers } from "./browser-request.js";
import { makeClient, makeRequest } from "./browser-request.test-support.js";

type RequestOptions = Parameters<(typeof browserHandlers)["browser.request"]>[0];
type TestNode = ReturnType<RequestOptions["context"]["nodeRegistry"]["listConnected"]>[number];
const browserNode = (nodeId = "node-1", extra: Partial<TestNode> = {}): TestNode => ({
  nodeId,
  caps: ["browser"],
  commands: ["browser.proxy"],
  platform: "linux",
  ...extra,
  declaredCommands: extra.declaredCommands ?? [],
});
const upload = {
  envelope: "browser-upload-v1",
  files: [{ name: "report.txt", contentBase64: "aGk=" }],
};
const uploadBody = { paths: ["/tmp/openclaw/uploads/report.txt"], ref: "e12" };
const dashboard = { sessionKey: "agent:main:browser-dashboard-proof", name: "service" };
const click = { method: "POST", target: "node", body: { kind: "click", ref: "e1" } };
const sessionKey = "agent:main:scope-a";
const tabScope = { sessionKey };
const invalidTabScope = {
  sessionKey,
  referencedTabs: [{ target: "host", node: "node-1", targetId: "t1" }],
};
const hostUnavailable = {
  ok: false,
  error: {
    code: "UNAVAILABLE",
    message: "Browser control host is not reachable on 127.0.0.1:18791.",
  },
};
function dispatchLocally(body: unknown = { ok: true }, status = 200) {
  m.start.mockResolvedValueOnce(true);
  m.dispatch.mockResolvedValueOnce({ status, body });
}
function policy(mode: "auto" | "manual" | "off" = "auto", selectedNode?: string) {
  m.config.mockReturnValue({ gateway: { nodes: { browser: { mode, node: selectedNode } } } });
}
type NodeInvoke = RequestOptions["context"]["nodeRegistry"]["invoke"];
type NodeInvokeResult = Awaited<ReturnType<NodeInvoke>>;
function createContext(
  result: NodeInvokeResult | NodeInvoke = { ok: true, payload: { result: { ok: true } } },
  nodes = [browserNode("node-1", { commands: ["browser.proxy", "browser.proxy.upload.v1"] })],
) {
  return {
    invoke: vi.fn<NodeInvoke>(async (params) =>
      typeof result === "function" ? result(params) : result,
    ),
    listConnected: vi.fn(() => nodes),
  };
}

async function runRequest(
  path: string,
  params: Record<string, unknown> = {},
  invokeResult?: NodeInvokeResult | NodeInvoke,
  connectedNodes?: TestNode[],
  requester: Partial<Pick<RequestOptions, "client" | "hasCurrentClientAuthority" | "signal">> = {},
) {
  const respond = vi.fn<RequestOptions["respond"]>();
  const nodeRegistry = createContext(invokeResult, connectedNodes);
  await browserHandlers["browser.request"](
    makeRequest(
      { method: "GET", path, ...params },
      { respond, context: { nodeRegistry }, ...requester },
    ),
  );
  return { respond, nodeRegistry };
}

function nodeInvocation(registry: ReturnType<typeof createContext>) {
  return expectDefined(registry.invoke.mock.calls[0], "node invocation")[0];
}
function reply(respond: Awaited<ReturnType<typeof runRequest>>["respond"]) {
  return expectDefined(respond.mock.calls[0], "browser response");
}
function expectFailure(respond: Awaited<ReturnType<typeof runRequest>>["respond"], error: object) {
  expect(reply(respond)).toEqual([false, undefined, expect.objectContaining(error)]);
}
function expectDispatch(request: object) {
  expect(m.dispatch).toHaveBeenCalledWith(expect.objectContaining(request));
}
function expectNoCalls(...mocks: unknown[]) {
  for (const mock of mocks) {
    expect(mock).not.toHaveBeenCalled();
  }
}

beforeEach(() => {
  m.hostAvailable.mockReset().mockReturnValue(false);
  policy();
  m.allowed.mockReturnValue({ ok: true });
  m.start.mockReset().mockResolvedValue(false);
  m.dispatch.mockReset();
  m.inspect.mockReset().mockResolvedValue({
    ...dashboard,
    instanceId: "instance-one",
    paused: false,
    browserTab: { target: "host", profile: "openclaw", targetId: "dashboard-tab" },
  });
  m.prepareUpload.mockReset().mockImplementation(async ({ body }: { body: unknown }) => ({ body }));
});

it.each([
  ["/reset-profile", { method: "POST", dashboard }, undefined],
  ["/tabs", { target: "node", node: "n".repeat(257) }, undefined],
  ["/profiles/import", { target: "node", method: "POST" }, undefined],
  [
    "/screencast",
    { method: "POST", target: "node", node: "node-1" },
    { code: "SCREENCAST_UNSUPPORTED", reason: "node" },
  ],
  ["/profiles/poc", { method: "DELETE" }, undefined],
  ["/reset-profile", { method: "POST", body: { profile: "poc", name: "poc" } }, undefined],
  ["/tabs", { tabScope: { sessionKey: "global" } }, undefined],
  ["/tabs", { tabScope: invalidTabScope }, undefined],
  ["/tabs", { tabScope, dashboard: { sessionKey, name: "board" } }, undefined],
] as const)(
  "rejects prohibited route %s before side effects: %j",
  async (path, params, details) => {
    const { respond, nodeRegistry } = await runRequest(path, params);
    expectFailure(respond, { code: "INVALID_REQUEST", ...(details ? { details } : {}) });
    expectNoCalls(m.dispatch, m.start, m.prepareUpload, nodeRegistry.invoke);
    if ("tabScope" in params) {
      expectNoCalls(m.inspect);
    }
  },
);

it("binds an omitted dashboard POST body to the retained tab", async () => {
  dispatchLocally({ targetId: "dashboard-tab" });
  const { respond } = await runRequest("/screenshot", {
    method: "POST",
    dashboard,
  });
  expect(reply(respond)[0]).toBe(true);
  expectDispatch({
    body: expect.objectContaining({ targetId: "dashboard-tab", profile: "openclaw" }),
  });
});

it("normalizes uploads before selecting their node command and preparing files", async () => {
  m.prepareUpload.mockResolvedValue({ body: { ref: "e1" }, upload });
  const { respond, nodeRegistry } = await runRequest("hooks/file-chooser/", {
    method: "POST",
    target: "node",
    body: { paths: ["/tmp/openclaw/uploads/report.txt"], ref: "e1" },
  });
  expect(nodeInvocation(nodeRegistry)).toMatchObject({
    command: "browser.proxy.upload.v1",
    params: { path: "/hooks/file-chooser", body: { ref: "e1" }, upload },
  });
  expect(nodeInvocation(nodeRegistry).params).not.toHaveProperty("body.paths");
  expect(reply(respond)[0]).toBe(true);
});

it.each(["cancelled", "invalidated", "revoked"] as const)(
  "never dispatches a node mutation after its requester is %s during preparation",
  async (reason) => {
    const invocation = new AbortController();
    const client = makeClient(new AbortController().signal);
    let current = true;
    m.prepareUpload.mockImplementationOnce(async ({ body }) => {
      if (reason === "cancelled") {
        invocation.abort(new Error("Browser request cancelled"));
      }
      if (reason === "invalidated") {
        client.invalidated = true;
      }
      if (reason === "revoked") {
        current = false;
      }
      return { body };
    });
    const { respond, nodeRegistry } = await runRequest("/act", click, undefined, undefined, {
      client,
      signal: invocation.signal,
      hasCurrentClientAuthority: () => current,
    });
    expect(m.prepareUpload.mock.calls[0]?.[0].signal).toBeInstanceOf(AbortSignal);
    expect(reply(respond)[0]).toBe(false);
    expectNoCalls(nodeRegistry.invoke, m.start);
  },
);

it("carries request cancellation and live authority into the node transport handoff", async () => {
  const connection = new AbortController();
  const invocation = new AbortController();
  const client = makeClient(connection.signal);
  const observations: unknown[] = [];
  const { respond } = await runRequest(
    "/act",
    click,
    async (request) => {
      observations.push(request.signal?.aborted, request.isDispatchAuthorized?.());
      client.invalidated = true;
      observations.push(request.isDispatchAuthorized?.());
      invocation.abort(new Error("Browser request cancelled"));
      observations.push(request.signal?.aborted);
      return { ok: false, error: { code: "CANCELLED", message: "Browser request cancelled" } };
    },
    undefined,
    { client, signal: invocation.signal },
  );
  expect(observations).toEqual([false, true, false, true]);
  expect(reply(respond)[0]).toBe(false);
  expect(m.start).not.toHaveBeenCalled();
});

it("invalidates dispatched requester authority immediately before the Gateway close handshake finishes", async () => {
  const connection = new AbortController();
  const client = makeClient(connection.signal);
  dispatchLocally({});
  await runRequest("/screencast", { method: "POST", target: "host" }, undefined, [], { client });
  const { requester } = expectDefined(m.dispatch.mock.calls[0], "local dispatch")[0];
  expect(requester).toMatchObject({ connId: "requester-1", signal: connection.signal });
  expect([requester.signal.aborted, requester.isCurrent()]).toEqual([false, true]);
  client.invalidated = true;
  expect([requester.isCurrent(), requester.signal.aborted]).toEqual([false, false]);
  connection.abort();
  expect(requester.signal.aborted).toBe(true);
});

it("does not replay a failed host action on a connected node", async () => {
  m.hostAvailable.mockImplementation((_config, profileName) => profileName === "local-work");
  const message = "navigation timed out after the page received the request";
  dispatchLocally({ error: message }, 500);

  const { respond, nodeRegistry } = await runRequest("/navigate", {
    method: "POST",
    query: { profile: "local-work" },
    body: { targetId: "local-tab", url: "https://example.com", profile: "node-work" },
  });

  expectFailure(respond, { code: "UNAVAILABLE", message, details: { error: message } });
  expectNoCalls(nodeRegistry.listConnected, nodeRegistry.invoke);
});

it("forces system-profile import host-local even when a browser node is connected", async () => {
  const { respond, nodeRegistry } = await runRequest("/profiles/import", {
    method: "POST",
    body: { browser: "chrome", systemProfile: "Default", into: "imported" },
  });

  expect(nodeRegistry.invoke).not.toHaveBeenCalled();
  expect(m.start).toHaveBeenCalled();
  expectFailure(respond, { message: expect.stringContaining("browser control disabled:") });
});

it("uses the original Gateway paths when an auto-selected old node lacks upload support", async () => {
  dispatchLocally({ ok: true });

  const { respond, nodeRegistry } = await runRequest(
    "/hooks/file-chooser",
    { method: "POST", body: uploadBody },
    undefined,
    [browserNode()],
  );

  expect(nodeRegistry.invoke).not.toHaveBeenCalled();
  expectDispatch({ method: "POST", path: "/hooks/file-chooser", body: uploadBody });
  expect(reply(respond)).toEqual([true, { ok: true }]);
  expect(m.prepareUpload).not.toHaveBeenCalled();
});

it("rejects configured-node uploads pending approval before preparation", async () => {
  policy("auto", "node-1");
  const { respond, nodeRegistry } = await runRequest(
    "/hooks/file-chooser",
    { method: "POST", body: uploadBody },
    undefined,
    [browserNode("node-1", { declaredCommands: ["browser.proxy", "browser.proxy.upload.v1"] })],
  );
  expectNoCalls(nodeRegistry.invoke, m.start, m.prepareUpload);
  expect(reply(respond)[2]?.message).toContain("remote upload transfer is pending approval");
});

it.each([
  ["missing", 0, "No connected browser-capable nodes"],
  ["disabled", 0, "Node browser proxy is disabled"],
  ["denied", 0, "node command not allowed"],
  ["automatic", 1, "browser control disabled:"],
  ["configured", 0, "Browser control host is not reachable"],
  ["ambiguous", 0, "UNAVAILABLE: node invoke timed out"],
] as const)("handles %s node failure without replaying actions", async (mode, starts, message) => {
  const explicit = ["missing", "disabled", "denied"].includes(mode);
  policy(mode === "disabled" ? "off" : "auto", mode === "configured" ? "node-1" : undefined);
  if (mode === "denied") {
    m.allowed.mockReturnValueOnce({ ok: false, reason: "not in allowlist" });
  }
  if (mode === "configured") {
    m.hostAvailable.mockReturnValue(true);
  }
  const failure =
    mode === "ambiguous"
      ? { ok: false, error: { code: "UNAVAILABLE", message: "node invoke timed out" } }
      : hostUnavailable;
  const { respond, nodeRegistry } = await runRequest(
    "/",
    explicit ? { target: "node" } : {},
    failure,
    mode === "missing" ? [] : undefined,
  );
  expect(m.start).toHaveBeenCalledTimes(starts);
  expectFailure(respond, { message: expect.stringContaining(message) });
  if (explicit) {
    expectNoCalls(nodeRegistry.invoke);
  }
});

const errorBody = {
  error: "headed mode needs a display",
  reason: "no_display_for_headed_profile",
  details: {
    profile: "openclaw",
    requestedHeadless: false,
    headlessSource: "config",
    displayPresent: false,
  },
};
it.each([
  {
    path: "/start",
    payload: { error: { status: 409, body: errorBody } },
    error: { code: "INVALID_REQUEST", message: errorBody.error, details: errorBody },
  },
  {
    path: "/screenshot",
    payload: { result: { path: "/node/browser/screenshot.png" } },
    error: { code: "UNAVAILABLE", message: "browser proxy file transfer failed" },
  },
])("maps node proxy failures for $path", async ({ path, payload, error }) => {
  const { respond } = await runRequest(path, { method: "POST" }, { ok: true, payload });
  expectFailure(respond, error);
});
describe("session tab scope", () => {
  const otherSessionKey = "agent:main:scope-b";
  const resolved = resolveBrowserConfig({ defaultProfile: "openclaw" });
  const profile = expectDefined(resolveProfile(resolved, "openclaw"), "host profile");
  type DispatchRequest = Parameters<ReturnType<typeof createBrowserRouteDispatcher>["dispatch"]>[0];
  function track(
    targetId: string,
    overrides: Partial<Parameters<typeof trackSessionBrowserTab>[0]> = {},
  ) {
    return trackSessionBrowserTab({ sessionKey, profile: "openclaw", targetId, ...overrides });
  }
  function hostResponse(body: unknown, status = 200, afterDispatch?: () => void) {
    m.dispatch.mockImplementation(async (request: DispatchRequest) => {
      await request.assertCurrent?.(profile);
      afterDispatch?.();
      return { status, body };
    });
  }

  beforeEach(() => {
    m.start.mockReset().mockResolvedValue({ resolved });
    m.inspect.mockReset();
  });

  afterEach(async () => {
    await closeTrackedBrowserTabsForSessions({
      sessionKeys: [sessionKey, otherSessionKey],
      closeTab: async () => {},
    });
    vi.restoreAllMocks();
  });

  it.each(["host", "node"] as const)(
    "filters %s tabs by session, canonical route and profile",
    async (target) => {
      const node = browserNode("canonical-node", { displayName: "Work Browser" });
      const profileName = target === "host" ? "openclaw" : "node-profile";
      const owned = { targetId: "owned", tabId: "t0", url: "", blocked: true };
      const routeResult = { status: "resolved", profile: profileName, driver: "openclaw" };
      if (target === "node") {
        const opened = { ...owned, resolvedProfile: profileName };
        const { respond } = await runRequest(
          "/tabs/open",
          {
            target,
            method: "POST",
            query: { profile: "requested-profile" },
            body: { url: "https://example.com" },
            tabScope,
          },
          { ok: true, payload: { result: opened, route: routeResult } },
          [node],
        );
        expect(reply(respond)).toEqual([true, opened]);
      } else {
        await track("owned");
      }
      await track("other-owned", {
        sessionKey: target === "host" ? otherSessionKey : sessionKey,
        profile: profileName,
        route:
          target === "node"
            ? createBrowserNodeSessionTabRoute({ ...node, nodeId: "other-node" })
            : undefined,
      });
      const referenced = { targetId: "referenced", tabId: "t9" };
      const tabs = [
        owned,
        referenced,
        { targetId: "other-owned" },
        { targetId: "outside-openclaw" },
        { targetId: "profile-collision", tabId: "t1" },
        { targetId: "node-collision", tabId: "t3" },
      ];
      const result = { running: true, tabs };
      hostResponse(result);
      const reference = (targetId: string, referenceProfile = profileName) => ({
        target,
        profile: referenceProfile,
        targetId,
        ...(target === "node" ? { node: node.nodeId } : {}),
      });
      const { respond, nodeRegistry } = await runRequest(
        "/tabs",
        {
          target,
          ...(target === "node"
            ? { node: "Work Browser", query: { profile: "requested-profile" } }
            : {}),
          tabScope: {
            sessionKey: ` ${sessionKey} `,
            referencedTabs: [
              reference(target === "host" ? "referenced" : "t9"),
              reference("t1", "other-profile"),
              { target: "node", node: "other-node", profile: profileName, targetId: "t3" },
            ],
          },
        },
        { ok: true, payload: { result, route: routeResult } },
        [node],
      );
      expect(reply(respond)).toEqual([true, { running: true, tabs: [owned, referenced] }]);
      if (target === "host") {
        const dock = await runRequest("/tabs", { target });
        expect(reply(dock.respond)).toEqual([true, result]);
      } else {
        expect(nodeInvocation(nodeRegistry)).toMatchObject({
          nodeId: "canonical-node",
          params: { profile: "requested-profile" },
        });
        expect(nodeInvocation(nodeRegistry).params).not.toHaveProperty("tabScope");
      }
    },
  );

  it("closes a newly opened tab on its resolved profile when cleanup tracking fails", async () => {
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
    const { respond } = await runRequest("/tabs/open", {
      target: "host",
      method: "POST",
      query: { profile: "requested-profile" },
      body: { url: "https://example.com" },
      tabScope: { sessionKey },
    });
    expectFailure(respond, {
      message: expect.stringContaining("Browser state runtime not initialized"),
    });
    expect(m.dispatch).toHaveBeenLastCalledWith(
      expect.objectContaining({
        method: "DELETE",
        path: "/tabs/opened%2Ftarget",
        query: { profile: "openclaw", targetIdMode: "raw" },
      }),
    );
  });

  it.each([
    ["POST", "/tabs/open", "success", ["owned", "opened"], 1],
    ["POST", "/tabs/open", "failure", ["owned"], 1],
    ["POST", "/tabs/open", "stale", ["owned"], 1],
    ["DELETE", "/tabs/owned", "success", [], 0],
    ["POST", "/tabs/focus", "success", ["owned"], 0],
    ["POST", "/screenshot", "success", ["owned"], 1],
  ] as const)(
    "updates ownership for %s %s (%s)",
    async (method, path, outcome, targetIds, expired) => {
      vi.spyOn(Date, "now").mockReturnValue(9_000);
      await track("owned", { now: 1_000 });
      let current = true;
      hostResponse(
        { targetId: "opened", resolvedProfile: "openclaw" },
        outcome === "failure" ? 500 : 200,
        () => {
          current = outcome !== "stale";
        },
      );
      const { respond } = await runRequest(
        path,
        { target: "host", method, body: { targetId: "owned" }, tabScope: { sessionKey } },
        undefined,
        undefined,
        { hasCurrentClientAuthority: () => current },
      );
      expect(reply(respond)[0]).toBe(outcome === "success");
      const tracked = await filterTrackedSessionBrowserTabs({
        sessionKey,
        profile: "openclaw",
        tabs: [{ targetId: "owned" }, { targetId: "opened" }],
      });
      expect(tracked).toEqual(targetIds.map((targetId) => ({ targetId })));
      const closeTab = vi.fn(async () => {});
      await sweepTrackedBrowserTabs({
        now: 10_000,
        idleMs: 5_000,
        closeTab,
        sessionFilter: (key) => key === sessionKey,
      });
      expect(closeTab).toHaveBeenCalledTimes(expired);
    },
  );
});
