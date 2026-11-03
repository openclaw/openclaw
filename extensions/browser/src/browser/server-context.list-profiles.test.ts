import { SdkError, SdkErrorCode } from "@modelcontextprotocol/client";
import { expectDefined } from "@openclaw/normalization-core";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import "./server-context.chrome-test-harness.js";
import { listChromeMcpTabs } from "./chrome-mcp-tabs.js";
import { getChromeMcpModule } from "./chrome-mcp.runtime.js";
import {
  createSessionStub,
  fakeListPagesResult,
  installChromeMcpSessionTestHooks,
  setChromeMcpSessionFactoryForTest,
} from "./chrome-mcp.test-support.js";
import * as chromeModule from "./chrome.js";
import { registerBrowserBasicRoutes } from "./routes/basic.js";
import { createBrowserRouteApp, createBrowserRouteResponse } from "./routes/test-helpers.js";
import { createBrowserRouteContext } from "./server-context.js";
import { beginProfileTransition } from "./server-context.lifecycle.js";
import {
  makeBrowserProfile,
  makeBrowserServerState,
  mockLaunchedChrome,
} from "./server-context.test-harness.js";

const { mockChromeMcpProcesses } = await vi.hoisted(
  () => import("./chrome-mcp-process.test-support.js"),
);

installChromeMcpSessionTestHooks();
beforeEach(() => getChromeMcpModule.clear());

afterEach(() => {
  getChromeMcpModule.clear();
  vi.clearAllMocks();
});

function createExistingSessionProcessFixture(attachElapsedMs = 0) {
  const profile = makeBrowserProfile({
    name: "chrome-live",
    driver: "existing-session",
    attachOnly: true,
    cdpUrl: "",
    cdpPort: 0,
    userDataDir: "/tmp/openclaw-browser-status-1",
  });
  const state = makeBrowserServerState({ profile });
  const alive = new Set<number>();
  let nextPid = 40_000;
  const listProcesses = vi.fn(async () =>
    [...alive].map((pid) => ({ pid, ppid: 1, identity: `fixture:${pid}` })),
  );
  mockChromeMcpProcesses({
    platform: "linux",
    listProcesses,
    sleep: async () => {},
    killProcess: (pid) => alive.delete(pid),
  });
  const callTool = vi.fn(
    async (
      _request: { name: string; arguments?: Record<string, unknown> },
      _requestOptions?: { signal?: AbortSignal; timeout?: number },
    ) => fakeListPagesResult(),
  );
  const factory = vi.fn(() => {
    if (attachElapsedMs) {
      const now = performance.now.bind(performance);
      vi.spyOn(performance, "now").mockImplementation(() => now() + attachElapsedMs);
    }
    const pid = nextPid++;
    alive.add(pid);
    const session = createSessionStub(callTool, pid);
    session.processCleanup = { status: "open" };
    vi.spyOn(session.client, "close").mockImplementation(async () => {
      alive.delete(pid);
      Object.assign(session.transport, { pid: null });
    });
    return session;
  });
  setChromeMcpSessionFactoryForTest(factory);
  const ctx = createBrowserRouteContext({ getState: () => state });
  const { app, getHandlers } = createBrowserRouteApp();
  registerBrowserBasicRoutes(app, ctx);
  const response = createBrowserRouteResponse();
  const status = () =>
    getHandlers.get("/")?.({ params: {}, query: { profile: profile.name } }, response.res);
  return { callTool, factory, listProcesses, profile, ctx, response, status };
}

it("uses request-scoped cold probes and reuses a warm MCP session", async () => {
  const fixture = createExistingSessionProcessFixture();
  const { ctx } = fixture;
  await ctx.listProfiles();
  expect((await ctx.listProfiles())[0]).toMatchObject({ running: true, tabCount: 1 });
  expect(fixture.factory).toHaveBeenCalledTimes(2);
  expect(fixture.callTool).toHaveBeenCalledWith(
    { name: "list_pages", arguments: {} },
    { signal: expect.any(AbortSignal), timeout: 300 },
  );
  const profile = ctx.forProfile(fixture.profile.name).profile;
  await listChromeMcpTabs(profile.name, profile);
  fixture.listProcesses.mockClear();
  expect((await ctx.listProfiles())[0]).toMatchObject({ running: true, tabCount: 1 });
  expect(fixture.factory).toHaveBeenCalledTimes(3);
  expect(fixture.listProcesses).not.toHaveBeenCalled();
});

it("preserves healthy transport status when the shared page probe fails", async () => {
  const fixture = createExistingSessionProcessFixture();
  fixture.callTool.mockRejectedValue(new Error("page unavailable"));
  const { ctx, response, status } = fixture;
  await status();

  expect(response.body).toMatchObject({ running: true, cdpReady: true, pageReady: false });

  expect((await ctx.listProfiles())[0]).toMatchObject({ running: true, tabCount: 0 });
});

it("times out a stuck status page probe within the budget remaining after attach", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000);
  const fixture = createExistingSessionProcessFixture(3_000);
  fixture.callTool.mockImplementation(async (_request, requestOptions) => {
    return await new Promise<never>((_resolve, reject) => {
      const timer = setTimeout(
        () => reject(new SdkError(SdkErrorCode.RequestTimeout, "Request timed out")),
        requestOptions?.timeout ?? 60_000,
      );
      requestOptions?.signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          reject(new SdkError(SdkErrorCode.RequestTimeout, "Request cancelled"));
        },
        { once: true },
      );
    });
  });
  const { response, status } = fixture;
  const pending = status();
  await vi.advanceTimersByTimeAsync(0);

  expect(fixture.callTool).toHaveBeenCalledWith(
    { name: "list_pages", arguments: {} },
    { signal: expect.any(AbortSignal), timeout: 4_000 },
  );
  await vi.advanceTimersByTimeAsync(3_999);
  expect(response.body).toBeUndefined();

  await vi.advanceTimersByTimeAsync(1);
  await pending;

  expect(response).toMatchObject({
    statusCode: 200,
    body: { running: true, cdpReady: true, pageReady: false },
  });
});

it("cancels one waiter while other probes observe the settled profile transition", async () => {
  const state = makeBrowserServerState();
  const ctx = createBrowserRouteContext({ getState: () => state });
  const profile = ctx.forProfile("openclaw");
  const runtime = expectDefined(state.profiles.get("openclaw"), "profile runtime");
  runtime.running = mockLaunchedChrome(vi.mocked(chromeModule.launchOpenClawChrome), 123);
  const cleanup = createDeferred<void>();
  const transitionCompleted = vi.fn();
  const transition = beginProfileTransition({
    state,
    runtime,
    reason: "profile refresh requested",
    closeSharedAdapters: false,
    afterCleanup: async () => {
      await cleanup.promise;
      runtime.running = null;
      transitionCompleted();
    },
  });
  const isChromeCdpReady = vi.mocked(chromeModule.isChromeCdpReady);
  isChromeCdpReady.mockResolvedValue(true);
  vi.mocked(chromeModule.isChromeReachable).mockResolvedValue(false);

  const controller = new AbortController();
  const aborted = profile.isReachable(undefined, { signal: controller.signal });
  const survivingCompleted = vi.fn();
  const surviving = profile.isReachable().finally(survivingCompleted);
  const listing = ctx.listProfiles();

  const reason = new Error("profile request cancelled during transition");
  controller.abort(reason);

  try {
    await expect(aborted).rejects.toBe(reason);
    expect(transitionCompleted).not.toHaveBeenCalled();
    expect(survivingCompleted).not.toHaveBeenCalled();
    expect(isChromeCdpReady).not.toHaveBeenCalled();
  } finally {
    cleanup.resolve();
    await transition;
  }

  await expect(surviving).resolves.toBe(true);
  expect(survivingCompleted).toHaveBeenCalledOnce();
  await expect(profile.isReachable()).resolves.toBe(true);
  expect(isChromeCdpReady).toHaveBeenCalledTimes(2);
  expect((await listing)[0]?.running).toBe(false);
});

it("marks a runtime-only constructor profile as missing from config", async () => {
  const profile = makeBrowserProfile({ name: "constructor" });
  const state = makeBrowserServerState({
    profile,
    resolvedOverrides: { profiles: {} },
  });
  state.profiles.set(profile.name, {
    profile,
    running: { pid: 123 } as never,
    lastTargetId: null,
  });

  const ctx = createBrowserRouteContext({ getState: () => state });
  const profiles = await ctx.listProfiles();

  expect(profiles).toHaveLength(1);
  expect(profiles[0]).toMatchObject({ name: "constructor", missingFromConfig: true });
});
