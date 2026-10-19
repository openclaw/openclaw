import type { GatewayRequestHandlers } from "openclaw/plugin-sdk/gateway-runtime";
import { beforeEach, expect, it, vi } from "vitest";
import { deferredOperation } from "./browser-request.test-support.js";
import { handleSessionBrowserGatewayRequest } from "./session-browser-request.js";

const m = vi.hoisted(() => ({ access: vi.fn(), dispatch: vi.fn(), tabs: vi.fn(), current: true }));
// mock-isolation: Session authorization tests use fixture-owned dashboards and dispatch without starting a browser.
vi.mock("../session-browser-dashboard.js", () => ({ accessSessionBrowserDashboard: m.access }));
// mock-isolation: Session authorization tests use fixture-owned dashboards and dispatch without starting a browser.
vi.mock("../browser-control-state.js", () => ({
  createBrowserControlContext: () => ({ forProfile: () => ({ listTabs: m.tabs }) }),
}));
// mock-isolation: Session authorization tests use fixture-owned dashboards and dispatch without starting a browser.
vi.mock("../browser/routes/dispatcher.js", () => ({
  createBrowserRouteDispatcher: () => ({ dispatch: m.dispatch }),
}));
const sessionKey = "agent:main:dashboard:one";
const binding = { profile: "openclaw", targetId: "isolated-tab" };
const target = { target: "host", ...binding };
const tabs = [
  { targetId: "admin-tab", title: "Private" },
  { targetId: "isolated-tab", title: "Review" },
];
const actions = [{ kind: "click", targetId: "admin-tab" }];
type Params = Record<string, unknown>;
const current = () => {
  if (!m.current) {
    throw new Error("access revoked");
  }
};
async function request(path: string, params: Params = {}) {
  const respond = vi.fn();
  await handleSessionBrowserGatewayRequest({
    params: {
      sessionKey,
      agentId: "main",
      dashboard: { name: "review", instanceId: "widget" },
      method: "POST",
      path,
      ...params,
    },
    respond,
    sessionAccessAuthority: {
      target: { sessionKey, agentId: "main", sessionId: "one" },
      assertCurrent: current,
      retain: () => ({
        signal: new AbortController().signal,
        assertCurrent: current,
        release: vi.fn(),
      }),
    },
  } as unknown as Parameters<GatewayRequestHandlers[string]>[0]);
  return respond;
}
async function rejectedRequest(path: string, message: string, params: Params = {}) {
  const respond = await request(path, params);
  expect(respond).toHaveBeenCalledWith(
    false,
    undefined,
    expect.objectContaining({ message: expect.stringContaining(message) }),
  );
  expect(m.dispatch).not.toHaveBeenCalled();
}
beforeEach(() => {
  vi.clearAllMocks();
  m.current = true;
  m.access.mockResolvedValue({
    response: { browserTab: target, paused: false },
    resource: { assertCurrent: current, signal: new AbortController().signal },
  });
  m.dispatch.mockResolvedValue({ status: 200, body: { ok: true } });
  m.tabs.mockResolvedValue(tabs);
});

it("accepts the Control UI dashboard envelope and carries its timeout into startup", async () => {
  const respond = await request("/dashboard", { body: {}, timeoutMs: 120_000 });
  expect(respond).toHaveBeenCalledWith(true, expect.objectContaining({ browserTab: target }));
  expect(m.access).toHaveBeenCalledWith(
    expect.objectContaining({ sessionKey, name: "review", instanceId: "widget" }),
    expect.anything(),
    expect.objectContaining({ operation: "open", signal: expect.any(AbortSignal) }),
  );
});

it("aborts the UI action deadline without publishing a late successful result", async () => {
  vi.useFakeTimers();
  const action = Promise.withResolvers<unknown>();
  m.dispatch.mockImplementationOnce(() => action.promise);
  try {
    const pending = request("/screenshot", { body: {}, timeoutMs: 100 });
    await vi.advanceTimersByTimeAsync(100);
    const respond = await pending;
    expect(respond.mock.calls[0]?.[0]).toBe(false);
    expect(m.dispatch.mock.calls[0]?.[0].signal.aborted).toBe(true);
    action.resolve({ status: 200, body: { private: true } });
    await Promise.resolve();
    expect(respond).toHaveBeenCalledOnce();
  } finally {
    vi.useRealTimers();
  }
});
it.each(["profile", "targetId", "node", "target"])(
  "rejects caller-selected %s before binding",
  async (selector) => {
    await rejectedRequest("/navigate", "cannot select", {
      body: { [selector]: "other", url: "https://example.test" },
    });
  },
);

it.each([
  ["/tabs/open", { body: {} }, "unavailable"],
  ["/act", { body: { kind: "batch", actions } }, "unavailable"],
  ["/act", { body: { kind: "close", actions } }, "unavailable"],
  [
    "/dashboard",
    { dashboard: { name: "review", sessionKey: "agent:main:foreign" } },
    "match the admitted session",
  ],
] as const)("rejects administration or conflicting identity at %s", async (path, params, error) => {
  await rejectedRequest(path, error, params);
  expect(m.access).not.toHaveBeenCalled();
});

it("passes a synchronous final fence to navigation and interaction dispatch", async () => {
  const events: string[] = [];
  m.dispatch.mockImplementationOnce(async ({ assertCurrent }) => {
    const assertion = assertCurrent();
    queueMicrotask(() => {
      m.current = false;
      events.push("revoked");
    });
    if (assertion) {
      await assertion;
    }
    events.push(m.current ? "authorized effect" : "stale effect");
    return { status: 200, body: { ok: true } };
  });
  const body = { kind: "evaluate", fn: "() => location.href" };
  await request("/act", { body });
  expect(events).toEqual(["authorized effect", "revoked"]);
  expect(m.dispatch.mock.lastCall?.[0]).toMatchObject({
    path: "/act",
    query: { ...binding, managedOnly: true },
    body: { ...body, ...binding },
  });
});

it("does not return data after authority changes during the action", async () => {
  m.dispatch.mockImplementationOnce(async () => {
    m.current = false;
    return { status: 200, body: { private: true } };
  });
  const respond = await request("/screenshot", { body: {} });
  expect(respond.mock.lastCall).toMatchObject([false, undefined, { message: "access revoked" }]);
  expect(respond).not.toHaveBeenCalledWith(true, expect.anything());
});

it.each([
  { method: "GET", path: "/tabs" },
  { method: "POST", path: "/screenshot" },
])("publishes $path in the same authorized turn as its final check", async (params) => {
  const completed = deferredOperation<unknown>();
  const operation = params.path === "/tabs" ? m.tabs : m.dispatch;
  operation.mockImplementationOnce(completed.run);
  const pending = request(params.path, params);
  await completed.entered;
  completed.resolve(params.path === "/tabs" ? tabs : { status: 200, body: { private: true } });
  const revoke = vi.fn(() => {
    m.current = false;
  });
  queueMicrotask(revoke);
  const respond = await pending;
  expect(respond).toHaveBeenCalledWith(true, expect.anything());
  expect(respond.mock.invocationCallOrder[0]).toBeLessThan(revoke.mock.invocationCallOrder[0]!);
  if (params.path === "/tabs") {
    expect(respond).toHaveBeenCalledWith(true, {
      running: true,
      tabs: [{ targetId: "isolated-tab", title: "Review" }],
    });
    expect(m.dispatch).not.toHaveBeenCalled();
  }
});
