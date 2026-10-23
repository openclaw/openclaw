import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserTab } from "../client.types.js";
import { makeBrowserProfile } from "../server-context.test-harness.js";
import { createRouteFixture } from "./request.test-support.js";
import { createBrowserRouteApp, createBrowserRouteResponse } from "./test-helpers.js";

const navigation = vi.hoisted(() => ({
  assertBrowserNavigationAllowed: vi.fn(async () => {}),
  assertBrowserNavigationResultAllowed: vi.fn(
    async (_opts?: { url: string; ssrfPolicy?: unknown }) => {},
  ),
  withBrowserNavigationPolicy: vi.fn((ssrfPolicy?: unknown) => (ssrfPolicy ? { ssrfPolicy } : {})),
}));

// mock-isolation: Observe tab URL policy decisions without resolving or connecting fixture addresses.
vi.mock("../navigation-guard.js", () => navigation);

const { registerBrowserTabRoutes } = await import("./tabs.js");

type ProfileContext = ReturnType<typeof makeProfile>;
const publicTab = (overrides: Partial<BrowserTab> = {}): BrowserTab => ({
  targetId: "T1",
  title: "Public",
  url: "https://example.com",
  type: "page",
  ...overrides,
});

const internalTab = () =>
  publicTab({ targetId: "T2", title: "Internal", url: "http://169.254.169.254/latest/meta-data/" });
const labeledTab = (targetId: string, tabId: string, label: string) =>
  publicTab({ targetId, tabId, label, suggestedTargetId: label });

const withTabs = (tabs: BrowserTab[]) => makeProfile({ listTabs: vi.fn(async () => tabs) });

function makeProfile(overrides?: Partial<ReturnType<typeof baseProfileContext>>) {
  return { ...baseProfileContext(), ...overrides };
}

const defaultTab = () => publicTab({ title: "Tab 1" });

function baseProfileContext() {
  return {
    profile: { name: "openclaw" },
    ensureBrowserAvailable: vi.fn(async () => {}),
    ensureTabAvailable: vi.fn(async () => defaultTab()),
    isReachable: vi.fn(async () => true),
    listTabs: vi.fn(async () => [defaultTab()]),
    openTab: vi.fn(async () => defaultTab()),
    labelTab: vi.fn(async (_targetId: string, label: string) => ({
      suggestedTargetId: label,
      ...defaultTab(),
      tabId: "t1",
      label,
    })),
    focusTab: vi.fn(async () => {}),
    closeTab: vi.fn(async (targetId: string) => targetId),
  };
}

function makeContext(
  profileCtx: ProfileContext,
  options?: { actionTimeoutMs?: number; ssrfPolicy?: unknown },
) {
  return {
    state: () => ({
      resolved: {
        actionTimeoutMs: options?.actionTimeoutMs ?? 45_000,
        extraArgs: [],
        ssrfPolicy: options?.ssrfPolicy,
      },
    }),
    forProfile: () => profileCtx,
    listProfiles: vi.fn(async () => []),
  };
}

async function request(params: {
  method: "get" | "post" | "delete";
  path: "/tabs" | "/tabs/action" | "/tabs/focus" | "/tabs/open" | "/tabs/:targetId";
  targetId?: string;
  body?: Record<string, unknown>;
  profileCtx: ProfileContext;
  actionTimeoutMs?: number;
  signal?: AbortSignal;
  ssrfPolicy?: unknown;
  query?: Record<string, unknown>;
  assertCurrent?: () => Promise<void>;
}) {
  const routes = createRouteFixture();
  registerBrowserTabRoutes(routes.app, makeContext(params.profileCtx, params) as never);
  return routes.request(params.method, params.path, {
    params: params.targetId === undefined ? {} : { targetId: params.targetId },
    query: params.query ?? {},
    body: params.body ?? {},
    signal: params.signal,
    assertCurrent: params.assertCurrent,
  });
}

it.each([{ driver: "existing-session" as const }, { cdpIsLoopback: false }, { attachOnly: true }])(
  "refuses managed dashboard tab lookup after a profile changes to %j",
  async (override) => {
    const profileCtx = makeProfile({ profile: makeBrowserProfile(override) });
    const response = await request({
      method: "get",
      path: "/tabs",
      query: { managedOnly: true },
      profileCtx,
    });
    expect(response.statusCode).toBe(400);
    expect(response.body).toEqual({
      error: "This dashboard requires a local managed browser profile",
    });
    expect(profileCtx.isReachable).not.toHaveBeenCalled();
    expect(profileCtx.listTabs).not.toHaveBeenCalled();
  },
);

it("does not open a dashboard tab after its owner disappears during browser startup", async () => {
  let ownerCurrent = true;
  const profileCtx = makeProfile({
    profile: makeBrowserProfile(),
    ensureBrowserAvailable: vi.fn(async () => {
      ownerCurrent = false;
    }),
  });
  const response = await open({
    body: { url: "http://service.example/", managedOnly: true },
    profileCtx,
    assertCurrent: async () => {
      if (!ownerCurrent) {
        throw new Error("dashboard was removed");
      }
    },
  });
  expectResponse(response, 500, { error: "Error: dashboard was removed" });
  expect(profileCtx.openTab).not.toHaveBeenCalled();
});

it("returns the profile that actually handled tab open", async () => {
  const tab = {
    ...publicTab({ targetId: "HOT-TAB", title: "Hot" }),
    ownership: {
      status: "durable" as const,
      nativeTargetId: "HOT-NATIVE",
      profileFingerprint: "sha256:profile",
      browserInstanceFingerprint: "sha256:browser",
    },
  };
  const profileCtx = makeProfile({
    profile: { name: "hot-profile" },
    openTab: vi.fn(async () => tab),
  });

  const response = await open({
    body: { url: "https://example.com" },
    profileCtx,
  });

  expect(response.body).toEqual({ ...tab, resolvedProfile: "hot-profile" });
});

it("rejects an invalid open timeoutMs before opening a tab", async () => {
  const profileCtx = makeProfile({ openTab: vi.fn() });
  const response = await open({
    body: { url: "https://example.com", timeoutMs: -5 },
    profileCtx,
  });
  expect(response.statusCode).toBe(400);
  expect(profileCtx.openTab).not.toHaveBeenCalled();
});

type RouteParams = Omit<Parameters<typeof request>[0], "method" | "path">;
const act = (params: RouteParams) => request({ ...params, method: "post", path: "/tabs/action" });
const list = (params: RouteParams) => request({ ...params, method: "get", path: "/tabs" });
const focus = (params: RouteParams) => request({ ...params, method: "post", path: "/tabs/focus" });
const open = (params: RouteParams) => request({ ...params, method: "post", path: "/tabs/open" });
const close = (params: RouteParams) =>
  request({ ...params, method: "delete", path: "/tabs/:targetId" });

function expectResponse(
  response: ReturnType<typeof createBrowserRouteResponse>,
  statusCode: number,
  body: unknown,
) {
  expect(response.statusCode).toBe(statusCode);
  expect(response.body).toEqual(body);
}

describe("browser tab routes", () => {
  afterEach(() => vi.useRealTimers());
  beforeEach(() => {
    navigation.assertBrowserNavigationAllowed.mockReset();
    navigation.assertBrowserNavigationResultAllowed.mockReset();
    navigation.withBrowserNavigationPolicy.mockReset();
    navigation.withBrowserNavigationPolicy.mockImplementation((ssrfPolicy?: unknown) =>
      ssrfPolicy ? { ssrfPolicy } : {},
    );
  });

  it.each([
    ["managed", {}, true],
    ["existing-session", { driver: "existing-session" }, false],
    ["attach-only", { attachOnly: true }, false],
    ["remote CDP", { cdpIsLoopback: false }, false],
    ["attach-only engine", { engine: "lightpanda" }, false],
  ] as const)(
    "advertises automatic preview resizing for %s ownership",
    async (_label, overrides, expected) => {
      const response = await list({
        profileCtx: makeProfile({ profile: makeBrowserProfile(overrides) }),
      });
      expect(response.statusCode).toBe(200);
      expect(response.body).toMatchObject({ running: true, canAutoResizeViewport: expected });
    },
  );

  it("validates tab-open input before resolving or leasing a profile", async () => {
    const profileCtx = makeProfile();
    const routeCtx = makeContext(profileCtx);
    const forProfile = vi.fn(routeCtx.forProfile);
    const { app, postHandlers } = createBrowserRouteApp();
    registerBrowserTabRoutes(app, { ...routeCtx, forProfile } as never);
    const response = createBrowserRouteResponse();

    await postHandlers.get("/tabs/open")?.({ params: {}, query: {}, body: {} }, response.res);

    expectResponse(response, 400, { error: "url is required" });
    expect(forProfile).not.toHaveBeenCalled();
  });

  it("returns tab-open navigation failures instead of a success payload", async () => {
    const navigationError = new Error("page.goto: net::ERR_NAME_NOT_RESOLVED");
    const profileCtx = makeProfile({
      openTab: vi.fn(async () => {
        throw navigationError;
      }),
    });

    const response = await request({
      method: "post",
      path: "/tabs/open",
      body: { url: "https://unresolved.example" },
      profileCtx,
    });

    expect(response.statusCode).toBe(500);
    expect(response.body).toEqual({ error: String(navigationError) });
    expect(profileCtx.openTab).toHaveBeenCalledWith("https://unresolved.example", {
      label: undefined,
      signal: expect.any(AbortSignal),
    });
  });

  it.each(["close", "select"] as const)(
    "returns browser-not-running for %s when the browser is not reachable",
    async (action) => {
      vi.useFakeTimers();
      const profileCtx = makeProfile({ isReachable: vi.fn(async () => false) });
      const pending = act({ body: { action, index: 0 }, profileCtx });
      await vi.runAllTimersAsync();
      expectResponse(await pending, 409, { error: "browser not running" });
      expect(profileCtx.listTabs).not.toHaveBeenCalled();
      expect(action === "close" ? profileCtx.closeTab : profileCtx.focusTab).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["T1", "T1", { targetIdMode: "raw" }, { exactTargetId: true }],
    ["docs", "T1_RAW", {}, {}],
  ] as const)(
    "closes %s in its namespace and returns %s",
    async (targetId, result, query, options) => {
      const profileCtx = makeProfile({ closeTab: vi.fn(async () => result) });
      const response = await close({ profileCtx, targetId, query });
      expectResponse(response, 200, { ok: true, targetId: result });
      expect(profileCtx.closeTab).toHaveBeenCalledWith(targetId, {
        ...options,
        signal: expect.any(AbortSignal),
      });
    },
  );

  it("rejects unknown target id modes before mutating a tab", async () => {
    const profileCtx = makeProfile();

    const response = await close({
      profileCtx,
      targetId: "T1",
      query: { targetIdMode: "friendly" },
    });

    expectResponse(response, 400, { error: 'targetIdMode must be "raw"' });
    expect(profileCtx.isReachable).not.toHaveBeenCalled();
    expect(profileCtx.closeTab).not.toHaveBeenCalled();
  });

  it("retries a transient reachability miss before mutating a tab", async () => {
    vi.useFakeTimers();
    const isReachable = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const profileCtx = makeProfile({ isReachable });

    const pending = act({ body: { action: "close", index: 0 }, profileCtx });
    await vi.runAllTimersAsync();
    const response = await pending;

    expect(response.statusCode).toBe(200);
    expect(isReachable).toHaveBeenCalledTimes(2);
    expect(profileCtx.closeTab).toHaveBeenCalledWith("T1", {
      exactTargetId: true,
      signal: expect.any(AbortSignal),
    });
  });

  it("does not retry or mutate after cancellation during the retry delay", async () => {
    vi.useFakeTimers();
    const abort = new AbortController();
    const isReachable = vi.fn(async () => false);
    const profileCtx = makeProfile({ isReachable });

    const pending = act({
      body: { action: "close", index: 0 },
      profileCtx,
      signal: abort.signal,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(isReachable).toHaveBeenCalledTimes(1);

    const abortReason = new Error("cancelled");
    abort.abort(abortReason);
    await vi.runAllTimersAsync();
    const response = await pending;

    expectResponse(response, 500, { error: "Error: cancelled" });
    expect(isReachable).toHaveBeenCalledTimes(1);
    expect(profileCtx.closeTab).not.toHaveBeenCalled();
  });

  it.each([
    ["existing-session", undefined, 45_000],
    ["existing-session", 0, 300],
    ["existing-session", Number.MAX_SAFE_INTEGER, MAX_TIMER_TIMEOUT_MS],
    ["openclaw", undefined, 300],
  ] as const)(
    "uses %s reachability timeout %s -> %s",
    async (driver, actionTimeoutMs, expected) => {
      const profileCtx = makeProfile({ profile: makeBrowserProfile({ driver }) });
      const signal = new AbortController().signal;
      const params = { profileCtx, signal, actionTimeoutMs };
      expect((await list(params)).statusCode).toBe(200);
      expect(profileCtx.isReachable).toHaveBeenLastCalledWith(expected, { signal });
      if (driver === "existing-session" && actionTimeoutMs === undefined) {
        expect((await act({ ...params, body: { action: "list" } })).statusCode).toBe(200);
        expect(profileCtx.isReachable).toHaveBeenNthCalledWith(2, expected, { signal });
      }
    },
  );

  it.each(["get", "post"] as const)(
    "explains unavailable URLs without leaking policy details in %s tab listings",
    async (method) => {
      const failedTab = publicTab({ targetId: "T3", url: "https://unresolved.example" });
      const blankTab = publicTab({ targetId: "T4", url: "" });
      const tabs = [publicTab(), internalTab(), failedTab, blankTab];
      navigation.assertBrowserNavigationResultAllowed.mockImplementation(async (opts) => {
        if (opts?.url === internalTab().url) {
          throw Object.assign(new Error(`Blocked address: ${opts.url}`), {
            name: "SsrFBlockedError",
          });
        }
        if (opts?.url === failedTab.url) {
          throw new Error(`getaddrinfo EAI_AGAIN ${opts.url}`);
        }
      });
      const profileCtx = withTabs(tabs);
      const listing = {
        method,
        path: method === "get" ? ("/tabs" as const) : ("/tabs/action" as const),
        body: { action: "list" },
        profileCtx,
        ssrfPolicy: {},
      };
      const response = await request(listing);

      expect(response.statusCode).toBe(200);
      expect(response.body).toEqual({
        ...(method === "get" ? { running: true, canAutoResizeViewport: false } : { ok: true }),
        tabs: [
          publicTab(),
          { ...internalTab(), url: "", urlUnavailableReason: "navigation_blocked" },
          { ...failedTab, url: "", urlUnavailableReason: "navigation_check_failed" },
          blankTab,
        ],
      });
      expect(JSON.stringify(response.body)).not.toContain(internalTab().url);
      expect(JSON.stringify(response.body)).not.toContain(failedTab.url);

      navigation.assertBrowserNavigationResultAllowed.mockResolvedValue(undefined);
      const recovered = await request(listing);
      expect(recovered.body).toEqual({
        ...(method === "get" ? { running: true, canAutoResizeViewport: false } : { ok: true }),
        tabs,
      });
    },
  );

  describe.each([
    { route: "focus", call: focus, body: { targetId: "T2" } },
    { route: "select", call: act, body: { action: "select", index: 1 } },
  ])("$route navigation policy", ({ call, body }) => {
    it("blocks a target URL that fails SSRF checks", async () => {
      navigation.assertBrowserNavigationResultAllowed.mockRejectedValueOnce(
        Object.assign(new Error("blocked"), { name: "SsrFBlockedError" }),
      );
      const profileCtx = withTabs([publicTab(), internalTab()]);
      const response = await call({ profileCtx, body, ssrfPolicy: { allowPrivateNetwork: false } });
      expect(response.statusCode).toBe(400);
      expect(profileCtx.focusTab).not.toHaveBeenCalled();
    });

    it("focuses without SSRF result validation when no policy is configured", async () => {
      const profileCtx = withTabs([publicTab(), internalTab()]);
      const response = await call({ profileCtx, body });
      expectResponse(response, 200, { ok: true, targetId: "T2" });
      expect(profileCtx.focusTab).toHaveBeenCalledWith("T2", {
        exactTargetId: true,
        signal: expect.any(AbortSignal),
      });
      expect(profileCtx.ensureTabAvailable).not.toHaveBeenCalled();
      expect(navigation.assertBrowserNavigationResultAllowed).not.toHaveBeenCalled();
    });
  });

  it.each([
    ["T404", [], 404],
    ["T1", [publicTab({ targetId: "T1abc" }), publicTab({ targetId: "T1def" })], 409],
    [
      "T2_RAW",
      [
        labeledTab("T1_RAW", "t1", "T2_RAW"),
        publicTab({ targetId: "T2_RAW", suggestedTargetId: "t2", tabId: "t2" }),
      ],
      409,
    ],
  ] as const)("rejects missing or ambiguous focus target %s", async (targetId, tabs, code) => {
    const profileCtx = withTabs([...tabs]);
    const response = await focus({
      profileCtx,
      body: { targetId },
      ssrfPolicy: { allowPrivateNetwork: false },
    });
    expect(response.statusCode).toBe(code);
    if (code === 409) {
      expect(response.body).toEqual({ error: "ambiguous browser tab reference" });
    }
    expect(profileCtx.ensureTabAvailable).not.toHaveBeenCalled();
    expect(profileCtx.focusTab).not.toHaveBeenCalled();
    expect(navigation.assertBrowserNavigationResultAllowed).not.toHaveBeenCalled();
  });

  it("resolves friendly tab references before focusing tabs", async () => {
    const profileCtx = withTabs([
      labeledTab("T1_RAW", "t1", "docs"),
      labeledTab("T2_RAW", "t2", "T1_RAW"),
    ]);

    const labelResponse = await focus({
      profileCtx,
      body: { targetId: "docs" },
    });
    const tabIdResponse = await focus({
      profileCtx,
      body: { targetId: "t1" },
    });

    expect(labelResponse.statusCode).toBe(200);
    expect(tabIdResponse.statusCode).toBe(200);
    const expectedCall = ["T1_RAW", { exactTargetId: true, signal: expect.any(AbortSignal) }];
    expect(profileCtx.focusTab.mock.calls).toEqual([expectedCall, expectedCall]);
  });

  it("rejects invalid tab action indexes instead of treating them as omitted", async () => {
    const profileCtx = makeProfile();

    for (const body of [
      { action: "close", index: "nope" },
      { action: "select", index: "1e0" },
      { action: "select", index: null },
    ]) {
      expectResponse(await act({ body, profileCtx }), 400, {
        error: "index must be a non-negative integer",
      });
    }
    expect(profileCtx.closeTab).not.toHaveBeenCalled();
    expect(profileCtx.focusTab).not.toHaveBeenCalled();
  });

  it("labels tabs by friendly target handles", async () => {
    const profileCtx = makeProfile();

    const response = await act({
      body: { action: "label", targetId: "t1", label: "meet" },
      profileCtx,
    });

    expectResponse(response, 200, {
      ok: true,
      tab: { ...defaultTab(), suggestedTargetId: "meet", tabId: "t1", label: "meet" },
    });
    expect(profileCtx.labelTab).toHaveBeenCalledWith("t1", "meet");
  });

  it("does not focus a tab after cancellation during target resolution", async () => {
    const abort = new AbortController();
    const listStarted = Promise.withResolvers<void>();
    const listTabs = vi.fn(async (options?: { signal?: AbortSignal }) => {
      const signal = options?.signal;
      listStarted.resolve();
      if (signal) {
        await new Promise<void>((_resolve, reject) => {
          const rejectAbort = () =>
            reject(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
          if (signal.aborted) {
            rejectAbort();
            return;
          }
          signal.addEventListener("abort", rejectAbort, { once: true });
        });
      }
      return [defaultTab()];
    });
    const focusTab = vi.fn(async () => {});
    const profileCtx = makeProfile({ listTabs, focusTab });

    const pending = focus({
      profileCtx,
      body: { targetId: "T1" },
      signal: abort.signal,
    });

    await listStarted.promise;
    abort.abort(new Error("cancelled"));
    const response = await pending;

    expect(response.statusCode).toBe(500);
    expect(focusTab).not.toHaveBeenCalled();
  });

  it("does not close a tab after cancellation before the mutation", async () => {
    const closeTab = vi.fn(async (targetId: string) => targetId);
    const profileCtx = makeProfile({ closeTab });
    const preAborted = new AbortController();
    preAborted.abort(new Error("pre-cancelled"));

    const response = await close({
      profileCtx,
      targetId: "T1",
      signal: preAborted.signal,
    });

    expect(closeTab).not.toHaveBeenCalled();
    expect(response.statusCode).toBe(500);
  });
});
