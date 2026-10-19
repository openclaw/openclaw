import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserTab } from "../client.types.js";
import { makeBrowserProfile } from "../server-context.test-harness.js";
import { createBrowserRouteApp, createBrowserRouteResponse } from "./test-helpers.js";

const navigationGuardMocks = vi.hoisted(() => ({
  assertBrowserNavigationAllowed: vi.fn(async () => {}),
  assertBrowserNavigationResultAllowed: vi.fn(
    async (_opts?: { url: string; ssrfPolicy?: unknown }) => {},
  ),
  withBrowserNavigationPolicy: vi.fn((ssrfPolicy?: unknown) => (ssrfPolicy ? { ssrfPolicy } : {})),
}));

vi.mock("../navigation-guard.js", () => navigationGuardMocks);

const { registerBrowserTabRoutes } = await import("./tabs.js");

type ProfileContext = ReturnType<typeof createProfileContext>;
type TabFixture = BrowserTab;

const publicTab = (overrides: Partial<TabFixture> = {}): TabFixture => ({
  targetId: "T1",
  title: "Public",
  url: "https://example.com",
  type: "page",
  ...overrides,
});

const internalTab = (): TabFixture => ({
  targetId: "T2",
  title: "Internal",
  url: "http://169.254.169.254/latest/meta-data/",
  type: "page",
});

const createProfileWithTabs = (tabs: TabFixture[]) =>
  createProfileContext({ listTabs: vi.fn(async () => tabs) });

function createProfileContext(overrides?: Partial<ReturnType<typeof baseProfileContext>>) {
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

function createRouteContext(
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

async function callTabsRoute(params: {
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
  const { app, getHandlers, postHandlers, deleteHandlers } = createBrowserRouteApp();
  registerBrowserTabRoutes(app, createRouteContext(params.profileCtx, params) as never);
  const handler = { get: getHandlers, post: postHandlers, delete: deleteHandlers }[
    params.method
  ].get(params.path);
  expect(handler).toBeTypeOf("function");

  const response = createBrowserRouteResponse();
  await handler?.(
    {
      params: params.targetId === undefined ? {} : { targetId: params.targetId },
      query: params.query ?? {},
      body: params.body ?? {},
      signal: params.signal,
      assertCurrent: params.assertCurrent,
    },
    response.res,
  );
  return response;
}

it.each([{ driver: "existing-session" as const }, { cdpIsLoopback: false }, { attachOnly: true }])(
  "refuses managed dashboard tab lookup after a profile changes to %j",
  async (override) => {
    const profileCtx = createProfileContext({ profile: makeBrowserProfile(override) });
    const response = await callTabsRoute({
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
  const profileCtx = createProfileContext({
    profile: makeBrowserProfile(),
    ensureBrowserAvailable: vi.fn(async () => {
      ownerCurrent = false;
    }),
  });
  const response = await callTabsOpen({
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
  const profileCtx = createProfileContext({
    profile: { name: "hot-profile" },
    openTab: vi.fn(async () => tab),
  });

  const response = await callTabsOpen({
    body: { url: "https://example.com" },
    profileCtx,
  });

  expect(response.body).toEqual({ ...tab, resolvedProfile: "hot-profile" });
});

it("rejects an invalid open timeoutMs before opening a tab", async () => {
  const profileCtx = createProfileContext({ openTab: vi.fn() });
  const response = await callTabsOpen({
    body: { url: "https://example.com", timeoutMs: -5 },
    profileCtx,
  });
  expect(response.statusCode).toBe(400);
  expect(profileCtx.openTab).not.toHaveBeenCalled();
});

type RouteParams = Omit<Parameters<typeof callTabsRoute>[0], "method" | "path">;
const callTabsAction = (params: RouteParams) =>
  callTabsRoute({ ...params, method: "post", path: "/tabs/action" });
const callTabsList = (params: RouteParams) =>
  callTabsRoute({ ...params, method: "get", path: "/tabs" });
const callTabsFocus = (params: RouteParams) =>
  callTabsRoute({ ...params, method: "post", path: "/tabs/focus" });
const callTabsOpen = (params: RouteParams) =>
  callTabsRoute({ ...params, method: "post", path: "/tabs/open" });
const callTabsDelete = (params: RouteParams) =>
  callTabsRoute({ ...params, method: "delete", path: "/tabs/:targetId" });

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
    navigationGuardMocks.assertBrowserNavigationAllowed.mockReset();
    navigationGuardMocks.assertBrowserNavigationResultAllowed.mockReset();
    navigationGuardMocks.withBrowserNavigationPolicy.mockReset();
    navigationGuardMocks.withBrowserNavigationPolicy.mockImplementation((ssrfPolicy?: unknown) =>
      ssrfPolicy ? { ssrfPolicy } : {},
    );
  });

  it.each([
    { label: "managed", overrides: {}, expected: true },
    {
      label: "existing-session",
      overrides: { driver: "existing-session" as const },
      expected: false,
    },
    { label: "attach-only", overrides: { attachOnly: true }, expected: false },
    { label: "remote CDP", overrides: { cdpIsLoopback: false }, expected: false },
    { label: "attach-only engine", overrides: { engine: "lightpanda" as const }, expected: false },
  ])(
    "advertises automatic preview resizing only for $label ownership",
    async ({ overrides, expected }) => {
      const response = await callTabsList({
        profileCtx: createProfileContext({ profile: makeBrowserProfile(overrides) }),
      });
      expect(response.statusCode).toBe(200);
      expect(response.body).toMatchObject({ running: true, canAutoResizeViewport: expected });
    },
  );

  it("validates tab-open input before resolving or leasing a profile", async () => {
    const profileCtx = createProfileContext();
    const routeCtx = createRouteContext(profileCtx);
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
    const profileCtx = createProfileContext({
      openTab: vi.fn(async () => {
        throw navigationError;
      }),
    });

    const response = await callTabsRoute({
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
      const profileCtx = createProfileContext({ isReachable: vi.fn(async () => false) });
      const pending = callTabsAction({ body: { action, index: 0 }, profileCtx });
      await vi.runAllTimersAsync();
      expectResponse(await pending, 409, { error: "browser not running" });
      expect(profileCtx.listTabs).not.toHaveBeenCalled();
      expect(action === "close" ? profileCtx.closeTab : profileCtx.focusTab).not.toHaveBeenCalled();
    },
  );

  it("closes an internally selected raw target through the exact namespace", async () => {
    const profileCtx = createProfileContext();

    const response = await callTabsDelete({
      profileCtx,
      targetId: "T1",
      query: { targetIdMode: "raw" },
    });

    expectResponse(response, 200, { ok: true, targetId: "T1" });
    expect(profileCtx.closeTab).toHaveBeenCalledWith("T1", {
      exactTargetId: true,
      signal: expect.any(AbortSignal),
    });
  });

  it("returns the canonical target id resolved behind a friendly close reference", async () => {
    const profileCtx = createProfileContext({
      closeTab: vi.fn(async () => "T1_RAW"),
    });

    const response = await callTabsDelete({ profileCtx, targetId: "docs" });

    expectResponse(response, 200, { ok: true, targetId: "T1_RAW" });
    expect(profileCtx.closeTab).toHaveBeenCalledWith("docs", { signal: expect.any(AbortSignal) });
  });

  it("rejects unknown target id modes before mutating a tab", async () => {
    const profileCtx = createProfileContext();

    const response = await callTabsDelete({
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
    const profileCtx = createProfileContext({ isReachable });

    const pending = callTabsAction({ body: { action: "close", index: 0 }, profileCtx });
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
    const profileCtx = createProfileContext({ isReachable });

    const pending = callTabsAction({
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

  it("uses the configured action timeout for existing-session tab reachability", async () => {
    const isReachable = vi.fn(async () => true);
    const abort = new AbortController();
    const profileCtx = createProfileContext({
      profile: {
        ...baseProfileContext().profile,
        driver: "existing-session",
      } as never,
      isReachable,
    });

    const listResponse = await callTabsList({ profileCtx, signal: abort.signal });
    const actionResponse = await callTabsAction({
      profileCtx,
      body: { action: "list" },
      signal: abort.signal,
    });

    expect(listResponse.statusCode).toBe(200);
    expect(actionResponse.statusCode).toBe(200);
    expect(isReachable).toHaveBeenNthCalledWith(1, 45_000, { signal: abort.signal });
    expect(isReachable).toHaveBeenNthCalledWith(2, 45_000, { signal: abort.signal });
  });

  it("keeps the short reachability probe for non-Chrome-MCP tab routes", async () => {
    const isReachable = vi.fn(async () => true);
    const profileCtx = createProfileContext({ isReachable });

    const response = await callTabsList({ profileCtx });

    expect(response.statusCode).toBe(200);
    expect(isReachable).toHaveBeenCalledWith(300, { signal: expect.any(AbortSignal) });
  });

  it("normalizes configured existing-session tab reachability timeouts", async () => {
    const isReachable = vi.fn(async () => true);
    const profileCtx = createProfileContext({
      profile: makeBrowserProfile({ driver: "existing-session" }),
      isReachable,
    });

    const zeroResponse = await callTabsList({ profileCtx, actionTimeoutMs: 0 });
    expect(zeroResponse.statusCode).toBe(200);
    expect(isReachable).toHaveBeenLastCalledWith(300, { signal: expect.any(AbortSignal) });

    const hugeResponse = await callTabsList({
      profileCtx,
      actionTimeoutMs: Number.MAX_SAFE_INTEGER,
    });
    expect(hugeResponse.statusCode).toBe(200);
    expect(isReachable).toHaveBeenLastCalledWith(MAX_TIMER_TIMEOUT_MS, {
      signal: expect.any(AbortSignal),
    });
  });

  it.each(["get", "post"] as const)(
    "explains unavailable URLs without leaking policy details in %s tab listings",
    async (method) => {
      const failedTab = publicTab({ targetId: "T3", url: "https://unresolved.example" });
      const blankTab = publicTab({ targetId: "T4", url: "" });
      const tabs = [publicTab(), internalTab(), failedTab, blankTab];
      navigationGuardMocks.assertBrowserNavigationResultAllowed.mockImplementation(async (opts) => {
        if (opts?.url === internalTab().url) {
          throw Object.assign(new Error(`Blocked address: ${opts.url}`), {
            name: "SsrFBlockedError",
          });
        }
        if (opts?.url === failedTab.url) {
          throw new Error(`getaddrinfo EAI_AGAIN ${opts.url}`);
        }
      });
      const profileCtx = createProfileWithTabs(tabs);
      const request = {
        method,
        path: method === "get" ? ("/tabs" as const) : ("/tabs/action" as const),
        body: { action: "list" },
        profileCtx,
        ssrfPolicy: {},
      };
      const response = await callTabsRoute(request);

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

      navigationGuardMocks.assertBrowserNavigationResultAllowed.mockResolvedValue(undefined);
      const recovered = await callTabsRoute(request);
      expect(recovered.body).toEqual({
        ...(method === "get" ? { running: true, canAutoResizeViewport: false } : { ok: true }),
        tabs,
      });
    },
  );

  it("blocks /tabs/focus when target tab URL fails SSRF checks", async () => {
    navigationGuardMocks.assertBrowserNavigationResultAllowed.mockRejectedValueOnce(
      Object.assign(new Error("blocked"), { name: "SsrFBlockedError" }),
    );
    const profileCtx = createProfileWithTabs([internalTab()]);

    const response = await callTabsFocus({
      profileCtx,
      body: { targetId: "T2" },
      ssrfPolicy: { allowPrivateNetwork: false },
    });

    expect(response.statusCode).toBe(400);
    expect(profileCtx.focusTab).not.toHaveBeenCalled();
  });

  it("does not create a tab for /tabs/focus when target is missing", async () => {
    const profileCtx = createProfileWithTabs([]);

    const response = await callTabsFocus({
      profileCtx,
      body: { targetId: "T404" },
      ssrfPolicy: { allowPrivateNetwork: false },
    });

    expect(response.statusCode).toBe(404);
    expect(profileCtx.ensureTabAvailable).not.toHaveBeenCalled();
    expect(profileCtx.focusTab).not.toHaveBeenCalled();
  });

  it("returns conflict for ambiguous target-id prefixes in /tabs/focus", async () => {
    const profileCtx = createProfileWithTabs([
      publicTab({ targetId: "T1abc", title: "Tab 1" }),
      publicTab({ targetId: "T1def", title: "Tab 2", url: "https://example.org" }),
    ]);

    const response = await callTabsFocus({ profileCtx, body: { targetId: "T1" } });

    expect(response.statusCode).toBe(409);
    expect(profileCtx.focusTab).not.toHaveBeenCalled();
    expect(navigationGuardMocks.assertBrowserNavigationResultAllowed).not.toHaveBeenCalled();
  });

  it("returns conflict when an exact tab reference identifies different tabs", async () => {
    const profileCtx = createProfileWithTabs([
      publicTab({
        targetId: "T1_RAW",
        suggestedTargetId: "T2_RAW",
        tabId: "t1",
        label: "T2_RAW",
      }),
      publicTab({
        targetId: "T2_RAW",
        suggestedTargetId: "t2",
        tabId: "t2",
        url: "https://example.org",
      }),
    ]);

    const response = await callTabsFocus({
      profileCtx,
      body: { targetId: "T2_RAW" },
      ssrfPolicy: { allowPrivateNetwork: false },
    });

    expect(response.statusCode).toBe(409);
    expect(response.body).toEqual({ error: "ambiguous browser tab reference" });
    expect(profileCtx.focusTab).not.toHaveBeenCalled();
    expect(navigationGuardMocks.assertBrowserNavigationResultAllowed).not.toHaveBeenCalled();
  });

  it("resolves friendly tab references before focusing tabs", async () => {
    const profileCtx = createProfileWithTabs([
      publicTab({
        targetId: "T1_RAW",
        suggestedTargetId: "docs",
        tabId: "t1",
        label: "docs",
      }),
      publicTab({
        targetId: "T2_RAW",
        suggestedTargetId: "T1_RAW",
        tabId: "t2",
        label: "T1_RAW",
        url: "https://example.org",
      }),
    ]);

    const labelResponse = await callTabsFocus({
      profileCtx,
      body: { targetId: "docs" },
    });
    const tabIdResponse = await callTabsFocus({
      profileCtx,
      body: { targetId: "t1" },
    });

    expect(labelResponse.statusCode).toBe(200);
    expect(tabIdResponse.statusCode).toBe(200);
    expect(profileCtx.focusTab).toHaveBeenNthCalledWith(1, "T1_RAW", {
      exactTargetId: true,
      signal: expect.any(AbortSignal),
    });
    expect(profileCtx.focusTab).toHaveBeenNthCalledWith(2, "T1_RAW", {
      exactTargetId: true,
      signal: expect.any(AbortSignal),
    });
  });

  it("blocks /tabs/action select when target tab URL fails SSRF checks", async () => {
    navigationGuardMocks.assertBrowserNavigationResultAllowed.mockRejectedValueOnce(
      Object.assign(new Error("blocked"), { name: "SsrFBlockedError" }),
    );
    const profileCtx = createProfileWithTabs([publicTab(), internalTab()]);

    const response = await callTabsAction({
      body: { action: "select", index: 1 },
      profileCtx,
      ssrfPolicy: { allowPrivateNetwork: false },
    });

    expect(response.statusCode).toBe(400);
    expect(profileCtx.focusTab).not.toHaveBeenCalled();
  });

  it("does not run SSRF result validation for /tabs/focus when policy is not configured", async () => {
    const profileCtx = createProfileContext({
      listTabs: vi.fn(async () => [internalTab()]),
    });

    const response = await callTabsFocus({
      profileCtx,
      body: { targetId: "T2" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({ ok: true, targetId: "T2" });
    expect(profileCtx.focusTab).toHaveBeenCalledWith("T2", {
      exactTargetId: true,
      signal: expect.any(AbortSignal),
    });
    expect(profileCtx.ensureTabAvailable).not.toHaveBeenCalled();
    expect(navigationGuardMocks.assertBrowserNavigationResultAllowed).not.toHaveBeenCalled();
  });

  it("does not run SSRF result validation for /tabs/action select when policy is not configured", async () => {
    const profileCtx = createProfileWithTabs([publicTab(), internalTab()]);

    const response = await callTabsAction({ body: { action: "select", index: 1 }, profileCtx });

    expectResponse(response, 200, { ok: true, targetId: "T2" });
    expect(profileCtx.focusTab).toHaveBeenCalledWith("T2", {
      exactTargetId: true,
      signal: expect.any(AbortSignal),
    });
    expect(navigationGuardMocks.assertBrowserNavigationResultAllowed).not.toHaveBeenCalled();
  });

  it("rejects invalid tab action indexes instead of treating them as omitted", async () => {
    const profileCtx = createProfileContext();

    for (const body of [
      { action: "close", index: "nope" },
      { action: "select", index: "1e0" },
      { action: "select", index: null },
    ]) {
      expectResponse(await callTabsAction({ body, profileCtx }), 400, {
        error: "index must be a non-negative integer",
      });
    }
    expect(profileCtx.closeTab).not.toHaveBeenCalled();
    expect(profileCtx.focusTab).not.toHaveBeenCalled();
  });

  it("labels tabs by friendly target handles", async () => {
    const profileCtx = createProfileContext();

    const response = await callTabsAction({
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
    let markListStarted: (() => void) | undefined;
    const listStarted = new Promise<void>((resolve) => {
      markListStarted = resolve;
    });
    const listTabs = vi.fn(async (options?: { signal?: AbortSignal }) => {
      const signal = options?.signal;
      markListStarted?.();
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
    const profileCtx = createProfileContext({ listTabs, focusTab });

    const pending = callTabsFocus({
      profileCtx,
      body: { targetId: "T1" },
      signal: abort.signal,
    });

    await listStarted;
    abort.abort(new Error("cancelled"));
    const response = await pending;

    expect(response.statusCode).toBe(500);
    expect(focusTab).not.toHaveBeenCalled();
  });

  it("does not close a tab after cancellation before the mutation", async () => {
    const closeTab = vi.fn(async (targetId: string) => targetId);
    const profileCtx = createProfileContext({ closeTab });
    const preAborted = new AbortController();
    preAborted.abort(new Error("pre-cancelled"));

    const response = await callTabsDelete({
      profileCtx,
      targetId: "T1",
      signal: preAborted.signal,
    });

    expect(closeTab).not.toHaveBeenCalled();
    expect(response.statusCode).toBe(500);
  });
});
