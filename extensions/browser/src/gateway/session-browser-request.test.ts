import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayRequestHandlers } from "../core-api.js";
import { handleSessionBrowserGatewayRequest } from "./session-browser-request.js";

const mocked = vi.hoisted(() => ({
  access: vi.fn(),
  dispatch: vi.fn(),
  tabs: vi.fn(),
  current: true,
}));
vi.mock("../session-browser-dashboard.js", () => ({
  accessSessionBrowserDashboard: mocked.access,
}));
vi.mock("../browser-control-state.js", () => ({
  createBrowserControlContext: () => ({ forProfile: () => ({ listTabs: mocked.tabs }) }),
}));
vi.mock("../browser/routes/dispatcher.js", () => ({
  createBrowserRouteDispatcher: () => ({ dispatch: mocked.dispatch }),
}));
const sessionKey = "agent:main:dashboard:one";
const target = { target: "host", profile: "openclaw", targetId: "isolated-tab" };
const current = () => {
  if (!mocked.current) {
    throw new Error("access revoked");
  }
};
async function request(params: Record<string, unknown>) {
  const respond = vi.fn();
  await handleSessionBrowserGatewayRequest({
    params: {
      sessionKey,
      agentId: "main",
      dashboard: { name: "review", instanceId: "widget" },
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
beforeEach(() => {
  vi.clearAllMocks();
  mocked.current = true;
  mocked.access.mockResolvedValue({
    response: { browserTab: target, paused: false },
    resource: {
      assertCurrent: current,
      signal: new AbortController().signal,
    },
  });
  mocked.dispatch.mockResolvedValue({ status: 200, body: { ok: true } });
  mocked.tabs.mockResolvedValue([
    { targetId: "admin-tab", title: "Private" },
    { targetId: "isolated-tab", title: "Review" },
  ]);
});

describe("closed session browser route", () => {
  it("accepts the Control UI dashboard envelope and carries its timeout into startup", async () => {
    const respond = await request({
      method: "POST",
      path: "/dashboard",
      body: {},
      timeoutMs: 120_000,
    });
    expect(respond).toHaveBeenCalledWith(true, expect.objectContaining({ browserTab: target }));
    expect(mocked.access).toHaveBeenCalledWith(
      expect.objectContaining({ sessionKey, name: "review", instanceId: "widget" }),
      expect.anything(),
      expect.objectContaining({ operation: "open", signal: expect.any(AbortSignal) }),
    );
  });

  it("aborts the UI action deadline without publishing a late successful result", async () => {
    vi.useFakeTimers();
    let finish!: (result: unknown) => void;
    mocked.dispatch.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    try {
      const pending = request({ method: "POST", path: "/screenshot", body: {}, timeoutMs: 100 });
      await vi.advanceTimersByTimeAsync(100);
      const respond = await pending;
      expect(respond.mock.calls[0]?.[0]).toBe(false);
      expect(mocked.dispatch.mock.calls[0]?.[0].signal.aborted).toBe(true);
      finish({ status: 200, body: { private: true } });
      await Promise.resolve();
      expect(respond).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
  it.each([
    "/cookies",
    "/storage/local",
    "/profiles",
    "/tabs/open",
    "/upload",
    "/download",
    "/pdf",
    "/stop",
  ])("does not forward %s", async (path) => {
    const respond = await request({ method: "POST", path, body: {} });
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: expect.stringContaining("unavailable") }),
    );
    expect(mocked.access).not.toHaveBeenCalled();
    expect(mocked.dispatch).not.toHaveBeenCalled();
  });

  it.each(["profile", "targetId", "node", "target"])(
    "rejects caller-selected %s before binding",
    async (selector) => {
      const respond = await request({
        method: "POST",
        path: "/navigate",
        body: { [selector]: "other", url: "https://example.test" },
      });
      expect(respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ message: expect.stringContaining("cannot select") }),
      );
      expect(mocked.dispatch).not.toHaveBeenCalled();
    },
  );

  it("returns only the owned tab for the real UI startup /tabs request", async () => {
    const respond = await request({ method: "GET", path: "/tabs" });
    expect(respond).toHaveBeenCalledWith(true, {
      running: true,
      tabs: [{ targetId: "isolated-tab", title: "Review" }],
    });
    expect(mocked.dispatch).not.toHaveBeenCalled();
  });

  it("binds navigation, evaluation and screenshot routes to the same isolated target", async () => {
    for (const [path, body] of [
      ["/navigate", { url: "https://example.test/" }],
      ["/act", { kind: "evaluate", fn: "() => location.href" }],
      ["/screenshot", {}],
    ] as const) {
      const respond = await request({ method: "POST", path, body });
      expect(respond).toHaveBeenCalledWith(true, { ok: true });
      expect(mocked.dispatch).toHaveBeenLastCalledWith(
        expect.objectContaining({
          path,
          query: expect.objectContaining({
            targetId: "isolated-tab",
            profile: "openclaw",
            managedOnly: true,
          }),
          body: expect.objectContaining({ ...body, targetId: "isolated-tab", profile: "openclaw" }),
        }),
      );
    }
  });

  it("rejects batch and close actions that could escape the single-tab operation contract", async () => {
    for (const kind of ["batch", "close"]) {
      const respond = await request({
        method: "POST",
        path: "/act",
        body: { kind, actions: [{ kind: "click", targetId: "admin-tab" }] },
      });
      expect(respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ message: expect.stringContaining("unavailable") }),
      );
    }
    expect(mocked.dispatch).not.toHaveBeenCalled();
  });

  it("passes a synchronous final fence to navigation and interaction dispatch", async () => {
    const events: string[] = [];
    mocked.dispatch.mockImplementationOnce(async ({ assertCurrent }) => {
      const assertion = assertCurrent();
      queueMicrotask(() => {
        mocked.current = false;
        events.push("revoked");
      });
      if (assertion) {
        await assertion;
      }
      events.push(mocked.current ? "authorized effect" : "stale effect");
      return { status: 200, body: {} };
    });
    await request({ method: "POST", path: "/navigate", body: { url: "https://example.test" } });
    expect(events).toEqual(["authorized effect", "revoked"]);
  });

  it("does not return data after authority changes during the action", async () => {
    mocked.dispatch.mockImplementationOnce(async () => {
      mocked.current = false;
      return { status: 200, body: { private: true } };
    });
    const respond = await request({ method: "POST", path: "/screenshot", body: {} });
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: "access revoked" }),
    );
    expect(respond).not.toHaveBeenCalledWith(true, expect.anything());
  });

  it.each([
    { method: "GET", path: "/tabs" },
    { method: "GET", path: "/snapshot" },
    { method: "POST", path: "/screenshot" },
  ])("publishes $path in the same authorized turn as its final check", async (params) => {
    const entered = Promise.withResolvers<void>();
    const completed = Promise.withResolvers<unknown>();
    const operation = params.path === "/tabs" ? mocked.tabs : mocked.dispatch;
    operation.mockImplementationOnce(() => {
      entered.resolve();
      return completed.promise;
    });
    const pending = request(params);
    await entered.promise;
    completed.resolve(params.path === "/tabs" ? [] : { status: 200, body: { private: true } });
    const revoke = vi.fn(() => {
      mocked.current = false;
    });
    queueMicrotask(revoke);
    const respond = await pending;
    expect(respond).toHaveBeenCalledWith(true, expect.anything());
    expect(respond.mock.invocationCallOrder[0]).toBeLessThan(revoke.mock.invocationCallOrder[0]!);
  });

  it("rejects conflicting nested and canonical session identities", async () => {
    const respond = await request({
      method: "POST",
      path: "/dashboard",
      dashboard: { name: "review", sessionKey: "agent:main:foreign" },
    });
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: expect.stringContaining("match the admitted session") }),
    );
    expect(mocked.access).not.toHaveBeenCalled();
  });
});
