import { expectDefined } from "@openclaw/normalization-core";
import type { GatewayRequestHandlers } from "openclaw/plugin-sdk/gateway-runtime";
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

const m = vi.hoisted(() => ({
  config: vi.fn(),
  allowed: vi.fn(),
  allowlist: vi.fn(),
  start: vi.fn<() => Promise<boolean | { resolved: ReturnType<typeof resolveBrowserConfig> }>>(),
  dispatch: vi.fn(),
  hostAvailable: vi.fn((_config: unknown, _profileName?: string) => false),
  inspect: vi.fn(),
  dashboardCurrent: vi.fn(),
  isUpload: vi.fn(
    (params: { method: string; path: string; body: unknown }) =>
      params.method === "POST" &&
      params.path === "/hooks/file-chooser" &&
      Array.isArray((params.body as { paths?: unknown } | undefined)?.paths) &&
      ((params.body as { paths: unknown[] }).paths.length ?? 0) > 0,
  ),
  prepareUpload: vi.fn(),
}));
vi.mock("../browser-host-availability.js", () => ({ isBrowserHostAvailable: m.hostAvailable }));
vi.mock("../browser-dashboard.js", () => ({
  inspectBrowserDashboard: m.inspect,
  assertBrowserDashboardTargetCurrent: m.dashboardCurrent,
}));
vi.mock("../control-service.js", () => ({ startBrowserControlServiceFromConfig: m.start }));
vi.mock("../browser-control-state.js", () => ({
  createBrowserControlContext: () => ({ control: true }),
}));
vi.mock("../browser/routes/dispatcher.js", () => ({
  createBrowserRouteDispatcher: () => ({ dispatch: m.dispatch }),
}));
vi.mock("../browser-proxy-upload.js", () => ({
  isBrowserProxyUploadRequest: m.isUpload,
  prepareBrowserProxyUploadRequest: m.prepareUpload,
}));
vi.mock("openclaw/plugin-sdk/runtime-config-snapshot", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/runtime-config-snapshot")>()),
  getRuntimeConfig: m.config,
  loadConfig: m.config,
}));
vi.mock("openclaw/plugin-sdk/gateway-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/gateway-runtime")>()),
  isNodeCommandAllowed: m.allowed,
  resolveNodeCommandAllowlist: m.allowlist,
}));

import { browserHandlers } from "./browser-request.js";

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

function createContext(invokeResult?: NodeInvokeResult | NodeInvoke, connectedNodes?: TestNode[]) {
  const invoke = vi.fn<NodeInvoke>(async (params) =>
    typeof invokeResult === "function"
      ? await invokeResult(params)
      : (invokeResult ?? { ok: true, payload: { result: { ok: true } } }),
  );
  return {
    invoke,
    listConnected: vi.fn(
      () =>
        connectedNodes ?? [
          browserNode("node-1", { commands: ["browser.proxy", "browser.proxy.upload.v1"] }),
        ],
    ),
  };
}

async function runRequest(
  params: Record<string, unknown>,
  invokeResult?: NodeInvokeResult | NodeInvoke,
  connectedNodes?: TestNode[],
  requester: Partial<Pick<RequestOptions, "client" | "hasCurrentClientAuthority" | "signal">> = {},
) {
  const respond = vi.fn<RequestOptions["respond"]>();
  const nodeRegistry = createContext(invokeResult, connectedNodes);
  await browserHandlers["browser.request"]({
    params,
    respond,
    context: { nodeRegistry },
    client: null,
    req: { type: "req", id: "req-1", method: "browser.request" },
    isWebchatConnect: () => false,
    ...requester,
  });
  return { respond, nodeRegistry };
}

function nodeInvocation(registry: ReturnType<typeof createContext>) {
  return expectDefined(registry.invoke.mock.calls[0], "node invocation")[0];
}
function reply(respond: Awaited<ReturnType<typeof runRequest>>["respond"]) {
  return expectDefined(respond.mock.calls[0], "browser response");
}
function invalid(respond: Awaited<ReturnType<typeof runRequest>>["respond"]) {
  expect(reply(respond)).toEqual([
    false,
    undefined,
    expect.objectContaining({ code: "INVALID_REQUEST" }),
  ]);
}

beforeEach(() => {
  m.hostAvailable.mockReset().mockReturnValue(false);
  policy();
  m.allowlist.mockReturnValue([]);
  m.allowed.mockReturnValue({ ok: true });
  m.start.mockReset().mockResolvedValue(false);
  m.dispatch.mockReset();
  m.inspect.mockReset().mockResolvedValue({
    sessionKey: "agent:main:browser-dashboard-proof",
    name: "service",
    instanceId: "instance-one",
    paused: false,
    browserTab: { target: "host", profile: "openclaw", targetId: "dashboard-tab" },
  });
  m.dashboardCurrent.mockReset().mockResolvedValue(undefined);
  m.isUpload.mockClear();
  m.prepareUpload.mockReset().mockImplementation(async ({ body }: { body: unknown }) => ({ body }));
});

describe("browser.request profile selection", () => {
  function requesterClient(
    connectionSignal: AbortSignal,
  ): NonNullable<Parameters<GatewayRequestHandlers[string]>[0]["client"]> {
    return {
      connId: "requester-1",
      connectionSignal,
      connect: {
        minProtocol: 3,
        maxProtocol: 3,
        client: { id: "test", version: "1", platform: "test", mode: "test" },
      },
    };
  }

  it("keeps dashboard-scoped requests away from profile mutations", async () => {
    dispatchLocally({ ok: true });
    const { respond, nodeRegistry } = await runRequest({
      method: "POST",
      path: "/reset-profile",
      dashboard: { sessionKey: "agent:main:browser-dashboard-proof", name: "service" },
    });
    invalid(respond);
    expect(m.dispatch).not.toHaveBeenCalled();
    expect(nodeRegistry.invoke).not.toHaveBeenCalled();
  });

  it("binds an omitted dashboard POST body to the retained tab", async () => {
    dispatchLocally({ targetId: "dashboard-tab" });
    const { respond } = await runRequest({
      method: "POST",
      path: "/screenshot",
      dashboard: { sessionKey: "agent:main:browser-dashboard-proof", name: "service" },
    });
    expect(reply(respond)[0]).toBe(true);
    expect(m.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({ targetId: "dashboard-tab", profile: "openclaw" }),
      }),
    );
  });

  it("normalizes uploads before selecting their node command and preparing files", async () => {
    m.prepareUpload.mockResolvedValue({ body: { ref: "e1" }, upload });
    const { respond, nodeRegistry } = await runRequest({
      method: "POST",
      path: "hooks/file-chooser/",
      target: "node",
      body: { paths: ["/tmp/openclaw/uploads/report.txt"], ref: "e1" },
    });
    expect(nodeInvocation(nodeRegistry)).toMatchObject({
      command: "browser.proxy.upload.v1",
      params: { path: "/hooks/file-chooser", body: { ref: "e1" }, upload },
    });
    expect(m.prepareUpload).toHaveBeenCalledWith(
      expect.objectContaining({ path: "/hooks/file-chooser" }),
    );
    expect(nodeInvocation(nodeRegistry).params).not.toHaveProperty("body.paths");
    expect(reply(respond)[0]).toBe(true);
  });

  it.each(["cancelled", "invalidated", "revoked"] as const)(
    "never dispatches a node mutation after its requester is %s during preparation",
    async (reason) => {
      const invocation = new AbortController();
      const client = requesterClient(new AbortController().signal);
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
      const { respond, nodeRegistry } = await runRequest(
        { method: "POST", path: "/act", target: "node", body: { kind: "click", ref: "e1" } },
        undefined,
        undefined,
        { client, signal: invocation.signal, hasCurrentClientAuthority: () => current },
      );
      expect(m.prepareUpload.mock.calls[0]?.[0].signal).toBeInstanceOf(AbortSignal);
      expect(reply(respond)[0]).toBe(false);
      expect(nodeRegistry.invoke).not.toHaveBeenCalled();
      expect(m.start).not.toHaveBeenCalled();
    },
  );

  it("carries request cancellation and live authority into the node transport handoff", async () => {
    const connection = new AbortController();
    const invocation = new AbortController();
    const client = requesterClient(connection.signal);
    const observations: unknown[] = [];
    const { respond } = await runRequest(
      { method: "POST", path: "/act", target: "node", body: { kind: "click", ref: "e1" } },
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

  it("returns the node's browser timeout diagnostic before the enclosing invoke watchdog", async () => {
    vi.useFakeTimers();
    try {
      const request = runRequest(
        { method: "GET", path: "/snapshot", target: "node", timeoutMs: 1_000 },
        async (invocation) =>
          await new Promise<NodeInvokeResult>((resolve) => {
            const proxyTimeoutMs = (invocation.params as { timeoutMs: number }).timeoutMs;
            const outer = setTimeout(() => {
              clearTimeout(inner);
              resolve({ ok: false, error: { code: "TIMEOUT", message: "node invoke timed out" } });
            }, invocation.timeoutMs);
            const inner = setTimeout(() => {
              clearTimeout(outer);
              resolve({
                ok: false,
                error: {
                  code: "UNAVAILABLE",
                  message: "browser proxy timed out; status(cdpReady=true)",
                },
              });
            }, proxyTimeoutMs + 750);
          }),
      );
      await vi.advanceTimersByTimeAsync(10_000);
      const { respond } = await request;
      expect(reply(respond)[2]?.message).toContain(
        "browser proxy timed out; status(cdpReady=true)",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("invalidates dispatched requester authority immediately before the Gateway close handshake finishes", async () => {
    const connection = new AbortController();
    const client = requesterClient(connection.signal);
    dispatchLocally({});
    await runRequest({ method: "POST", path: "/screencast", target: "host" }, undefined, [], {
      client,
    });
    const dispatched = m.dispatch.mock.calls[0]?.[0];
    expect(dispatched.requester).toMatchObject({
      connId: "requester-1",
      signal: connection.signal,
    });
    expect(dispatched.requester.signal.aborted).toBe(false);
    expect(dispatched.requester.isCurrent()).toBe(true);
    client.invalidated = true;
    expect(dispatched.requester.isCurrent()).toBe(false);
    expect(dispatched.requester.signal.aborted).toBe(false);
    connection.abort();
    expect(dispatched.requester.signal.aborted).toBe(true);
  });

  it("rejects node screencast before preparation or dispatch", async () => {
    const { respond, nodeRegistry } = await runRequest({
      method: "POST",
      path: "/screencast",
      target: "node",
      node: "node-1",
    });
    expect(reply(respond)).toEqual([
      false,
      undefined,
      {
        code: "INVALID_REQUEST",
        message: "browser screencast is not available over a node proxy",
        details: { code: "SCREENCAST_UNSUPPORTED", reason: "node" },
      },
    ]);
    expect(nodeRegistry.invoke).not.toHaveBeenCalled();
    expect(m.prepareUpload).not.toHaveBeenCalled();
    expect(m.start).not.toHaveBeenCalled();
  });

  it("does not replay a failed host action on a connected node", async () => {
    m.hostAvailable.mockImplementation((_config, profileName) => profileName === "local-work");
    m.start.mockResolvedValueOnce(true);
    const message = "navigation timed out after the page received the request";
    m.dispatch.mockResolvedValueOnce({ status: 500, body: { error: message } });

    const { respond, nodeRegistry } = await runRequest({
      method: "POST",
      path: "/navigate",
      query: { profile: "local-work" },
      body: { targetId: "local-tab", url: "https://example.com", profile: "node-work" },
    });

    expect(reply(respond)).toEqual([
      false,
      undefined,
      { code: "UNAVAILABLE", message, details: { error: message } },
    ]);
    expect(m.dispatch).toHaveBeenCalledOnce();
    expect(nodeRegistry.listConnected).not.toHaveBeenCalled();
    expect(nodeRegistry.invoke).not.toHaveBeenCalled();
  });

  it.each([
    { target: "node", node: "n".repeat(257) },
    { target: "node", method: "POST", path: "/profiles/import" },
  ])("rejects invalid or host-only route identity before dispatch: %j", async (route) => {
    const { respond, nodeRegistry } = await runRequest({ method: "GET", path: "/tabs", ...route });
    invalid(respond);
    expect(nodeRegistry.invoke).not.toHaveBeenCalled();
    expect(m.start).not.toHaveBeenCalled();
  });

  it.each(["missing node", "disabled policy", "denied command"])(
    "never retargets explicit node requests after %s",
    async (failure) => {
      if (failure === "disabled policy") {
        policy("off");
      }
      if (failure === "denied command") {
        m.allowed.mockReturnValueOnce({ ok: false, reason: "not in allowlist" });
      }
      const { respond } = await runRequest(
        { method: "GET", path: "/tabs", target: "node" },
        hostUnavailable,
        failure === "missing node" ? [] : [browserNode()],
      );
      expect(reply(respond)[0]).toBe(false);
      expect(m.start).not.toHaveBeenCalled();
    },
  );

  it("forces system-profile import host-local even when a browser node is connected", async () => {
    const { respond, nodeRegistry } = await runRequest({
      method: "POST",
      path: "/profiles/import",
      body: { browser: "chrome", systemProfile: "Default", into: "imported" },
    });

    expect(nodeRegistry.invoke).not.toHaveBeenCalled();
    expect(m.start).toHaveBeenCalled();
    const [ok, payload, error] = reply(respond);
    expect(ok).toBe(false);
    expect(payload).toBeUndefined();
    expect(error?.message).toContain("browser control disabled:");
  });

  it("honors a configured Unicode browser node in manual mode despite local availability", async () => {
    policy("manual", "Café01");

    m.hostAvailable.mockReturnValue(true);
    const { respond, nodeRegistry } = await runRequest(
      {
        method: "GET",
        path: "/profiles",
      },
      undefined,
      [
        browserNode("cafe-node", { displayName: "Cafe\u0301 01" }),
        browserNode("other-node", { displayName: "Other Browser" }),
      ],
    );

    const invoke = nodeInvocation(nodeRegistry);
    expect(invoke.nodeId).toBe("cafe-node");
    expect(invoke.command).toBe("browser.proxy");
    expect(invoke.params).toMatchObject({ method: "GET", path: "/profiles" });
    expect(reply(respond)[0]).toBe(true);
  });

  it.each([
    {
      method: "DELETE",
      path: "/profiles/poc",
      body: undefined,
    },
    {
      method: "POST",
      path: "/reset-profile",
      body: { profile: "poc", name: "poc" },
    },
  ])("blocks persistent profile mutations for $method $path", async ({ method, path, body }) => {
    const { respond, nodeRegistry } = await runRequest({
      method,
      path,
      body,
    });

    expect(nodeRegistry.invoke).not.toHaveBeenCalled();
    const [ok, payload, error] = reply(respond);
    expect(ok).toBe(false);
    expect(payload).toBeUndefined();
    expect(error?.message).toBe(
      "browser.request cannot mutate persistent browser profiles over a node proxy",
    );
  });

  it("dispatches host-local admin mutations when no node handles the request", async () => {
    const { respond, nodeRegistry } = await runRequest(
      { method: "POST", path: "/profiles/create", body: { name: "poc" } },
      undefined,
      [],
    );

    expect(nodeRegistry.invoke).not.toHaveBeenCalled();
    expect(m.start).toHaveBeenCalledOnce();
    const [ok, payload, error] = reply(respond);
    expect(ok).toBe(false);
    expect(payload).toBeUndefined();
    expect(error?.message).toContain("browser control disabled:");
  });

  it("falls back to host dispatch when an auto-selected node has no browser host", async () => {
    const { respond, nodeRegistry } = await runRequest(
      { method: "GET", path: "/" },
      hostUnavailable,
    );

    expect(nodeRegistry.invoke).toHaveBeenCalledOnce();
    expect(m.start).toHaveBeenCalledOnce();
    expect(reply(respond)[2]?.message).toContain("browser control disabled:");
  });

  it("uses the original Gateway paths when an auto-selected old node lacks upload support", async () => {
    dispatchLocally({ ok: true });

    const { respond, nodeRegistry } = await runRequest(
      {
        method: "POST",
        path: "/hooks/file-chooser",
        body: uploadBody,
      },
      undefined,
      [browserNode()],
    );

    expect(nodeRegistry.invoke).not.toHaveBeenCalled();
    expect(m.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "POST",
        path: "/hooks/file-chooser",
        body: uploadBody,
      }),
    );
    expect(reply(respond)).toEqual([true, { ok: true }]);
    expect(m.prepareUpload).not.toHaveBeenCalled();
  });

  it("rejects configured-node uploads pending approval before preparation", async () => {
    policy("auto", "node-1");
    const { respond, nodeRegistry } = await runRequest(
      { method: "POST", path: "/hooks/file-chooser", body: uploadBody },
      undefined,
      [browserNode("node-1", { declaredCommands: ["browser.proxy", "browser.proxy.upload.v1"] })],
    );
    expect(nodeRegistry.invoke).not.toHaveBeenCalled();
    expect(m.start).not.toHaveBeenCalled();
    expect(reply(respond)[2]?.message).toContain("remote upload transfer is pending approval");
    expect(m.prepareUpload).not.toHaveBeenCalled();
  });

  it("preserves a configured node failure instead of falling back to the host", async () => {
    m.hostAvailable.mockReturnValue(true);
    policy("auto", "node-1");
    const { respond } = await runRequest({ method: "GET", path: "/" }, hostUnavailable);

    expect(m.start).not.toHaveBeenCalled();
    expect(reply(respond)[2]?.message).toContain("Browser control host is not reachable");
  });

  it("preserves ambiguous auto-selected node failures", async () => {
    const { respond } = await runRequest(
      { method: "GET", path: "/" },
      {
        ok: false,
        error: { code: "UNAVAILABLE", message: "node invoke timed out" },
      },
    );

    expect(m.start).not.toHaveBeenCalled();
    expect(reply(respond)[2]?.message).toBe("UNAVAILABLE: node invoke timed out");
  });

  it("maps validated node-proxy route failures like local route failures", async () => {
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
    const { respond } = await runRequest(
      { method: "POST", path: "/start" },
      { ok: true, payload: { error: { status: 409, body: errorBody } } },
    );

    const [ok, payload, error] = reply(respond);
    expect(ok).toBe(false);
    expect(payload).toBeUndefined();
    expect(error).toMatchObject({
      code: "INVALID_REQUEST",
      message: "headed mode needs a display",
      details: errorBody,
    });
  });

  it.each([
    {
      name: "recognized action code",
      body: { error: "evaluation disabled", code: "ACT_EVALUATE_DISABLED" },
      details: { error: "evaluation disabled", code: "ACT_EVALUATE_DISABLED" },
    },
    {
      name: "unrecognized action code",
      body: { error: "evaluation disabled", code: "ACT_FUTURE_CODE" },
      details: { error: "evaluation disabled", unrecognizedCode: true },
    },
  ])("preserves bounded $name state through the node proxy", async ({ body, details }) => {
    const { respond } = await runRequest(
      { method: "POST", path: "/act" },
      { ok: true, payload: { error: { status: 403, body } } },
    );

    expect(reply(respond)[2]).toEqual({
      code: "INVALID_REQUEST",
      message: "evaluation disabled",
      details,
    });
  });

  it("returns UNAVAILABLE for an incomplete node file envelope", async () => {
    const { respond } = await runRequest(
      { method: "POST", path: "/screenshot" },
      {
        ok: true,
        payload: { result: { path: "/node/browser/screenshot.png" } },
      },
    );

    const [ok, payload, error] = reply(respond);
    expect(ok).toBe(false);
    expect(payload).toBeUndefined();
    expect(error).toMatchObject({
      code: "UNAVAILABLE",
      message: "browser proxy file transfer failed",
    });
  });
});

describe("session tab scope", () => {
  const sessionKey = "agent:main:scope-a";
  const otherSessionKey = "agent:main:scope-b";
  const resolved = resolveBrowserConfig({ defaultProfile: "openclaw" });
  const profile = expectDefined(resolveProfile(resolved, "openclaw"), "host profile");
  type DispatchRequest = Parameters<ReturnType<typeof createBrowserRouteDispatcher>["dispatch"]>[0];

  function hostResponse(body: unknown, status = 200, afterDispatch?: () => void) {
    m.dispatch.mockImplementation(async (request: DispatchRequest) => {
      await request.assertCurrent?.(profile);
      afterDispatch?.();
      return { status, body };
    });
  }

  beforeEach(() => {
    m.start.mockReset().mockResolvedValue({ resolved });
    m.dispatch.mockReset();
    m.inspect.mockReset();
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
    const { respond } = await runRequest({
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
    expect(reply(respond)).toEqual([true, { running: true, tabs: [owned, referenced] }]);
    const dock = await runRequest({ target: "host", method: "GET", path: "/tabs" });
    expect(reply(dock.respond)).toEqual([true, { running: true, tabs }]);
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
    const { respond } = await runRequest({
      target: "host",
      method: "POST",
      path: "/tabs/open",
      query: { profile: "requested-profile" },
      body: { url: "https://example.com" },
      tabScope: { sessionKey },
    });
    expect(reply(respond)).toEqual([
      false,
      undefined,
      expect.objectContaining({
        message: expect.stringContaining("Browser state runtime not initialized"),
      }),
    ]);
    expect(m.dispatch).toHaveBeenCalledTimes(2);
    expect(m.dispatch).toHaveBeenLastCalledWith(
      expect.objectContaining({
        method: "DELETE",
        path: "/tabs/opened%2Ftarget",
        query: { profile: "openclaw", targetIdMode: "raw" },
        assertCurrent: expect.any(Function),
      }),
    );
  });

  it("tracks panel-opened node tabs on their resolved profile", async () => {
    const opened = { targetId: "panel-opened", tabId: "t1", resolvedProfile: "openclaw" };
    const params = {
      target: "node",
      query: { profile: "requested-profile" },
      tabScope: { sessionKey },
    };
    const route = { status: "resolved", profile: "openclaw", driver: "openclaw" };
    async function dispatch(method: string, path: string, result: unknown, body?: unknown) {
      hostResponse(result);
      return runRequest(
        { ...params, method, path, body },
        { ok: true, payload: { result, route } },
        [browserNode()],
      );
    }
    const result = await dispatch("POST", "/tabs/open", opened, { url: "https://example.com" });
    expect(reply(result.respond)).toEqual([true, opened]);
    const listed = await dispatch("GET", "/tabs", {
      running: true,
      tabs: [opened, { targetId: "untracked" }],
    });
    expect(reply(listed.respond)).toEqual([true, { running: true, tabs: [opened] }]);
  });

  it.each([
    { path: "/tabs/open", method: "POST", outcome: "success" },
    { path: "/tabs/open", method: "POST", outcome: "failure" },
    { path: "/tabs/open", method: "POST", outcome: "stale" },
    { path: "/tabs/owned", method: "DELETE", outcome: "success" },
    { path: "/tabs/focus", method: "POST", outcome: "success" },
    { path: "/screenshot", method: "POST", outcome: "success" },
  ])(
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
      const { respond } = await runRequest(
        { target: "host", method, path, body: { targetId: "owned" }, tabScope: { sessionKey } },
        undefined,
        undefined,
        { hasCurrentClientAuthority: () => current },
      );
      expect(reply(respond)[0]).toBe(outcome === "success");
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
      declaredCommands: ["browser.proxy"],
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
    const { respond, nodeRegistry } = await runRequest(
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
    expect(reply(respond)).toEqual([true, { running: true, tabs: [owned, referenced] }]);
    expect(nodeInvocation(nodeRegistry)).toMatchObject({ nodeId: "canonical-node" });
    expect(nodeInvocation(nodeRegistry).params).toEqual({
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
    { tabScope: { sessionKey: "global" } },
    {
      tabScope: {
        sessionKey,
        referencedTabs: [{ target: "host", node: "node-1", targetId: "t1" }],
      },
    },
    { dashboard: { sessionKey, name: "board" } },
  ])("rejects invalid or dashboard-mixed tab scopes before dispatch: %j", async (params) => {
    const { respond, nodeRegistry } = await runRequest({
      method: "GET",
      path: "/tabs",
      tabScope: { sessionKey },
      ...params,
    });
    invalid(respond);
    expect(m.inspect).not.toHaveBeenCalled();
    expect(m.dispatch).not.toHaveBeenCalled();
    expect(nodeRegistry.invoke).not.toHaveBeenCalled();
  });
});
