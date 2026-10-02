import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { expectDefined } from "@openclaw/normalization-core";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import "./server-context.chrome-test-harness.js";
import { setChromeMcpProcessCleanupDepsForTest } from "./chrome-mcp-process.js";
import {
  resetChromeMcpSessionsForTest,
  setChromeMcpSessionFactoryForTest,
} from "./chrome-mcp-session.js";
import { listChromeMcpTabs } from "./chrome-mcp-tabs.js";
import * as chromeModule from "./chrome.js";
import { registerBrowserBasicRoutes } from "./routes/basic.js";
import { createBrowserRouteApp, createBrowserRouteResponse } from "./routes/test-helpers.js";
import { createBrowserRouteContext } from "./server-context.js";
import { beginProfileTransition } from "./server-context.lifecycle.js";
import { makeBrowserProfile, makeBrowserServerState } from "./server-context.test-harness.js";

afterEach(async () => {
  await resetChromeMcpSessionsForTest();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

function createExistingSessionProcessFixture(
  options: {
    pageFailure?: boolean;
    attachElapsedMs?: number;
    hangingPage?: boolean;
  } = {},
) {
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
  setChromeMcpProcessCleanupDepsForTest({
    platform: "linux",
    listProcesses,
    sleep: async () => {},
    killProcess: (pid) => alive.delete(pid),
  });
  const callTool = vi.fn(
    async (
      _request: { name: string; arguments?: Record<string, unknown> },
      _resultSchema?: unknown,
      requestOptions?: { signal?: AbortSignal; timeout?: number },
    ) => {
      if (options.hangingPage) {
        return await new Promise<never>((_resolve, reject) => {
          const timer = setTimeout(
            () => reject(new McpError(ErrorCode.RequestTimeout, "Request timed out")),
            requestOptions?.timeout ?? 60_000,
          );
          requestOptions?.signal?.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              reject(new McpError(ErrorCode.RequestTimeout, "Request cancelled"));
            },
            { once: true },
          );
        });
      }
      if (options.pageFailure) {
        throw new Error("page unavailable");
      }
      return {
        content: [{ type: "text", text: "## Pages\n1: https://example.com [selected]" }],
      };
    },
  );
  const factory = vi.fn(async () => {
    if (options.attachElapsedMs) {
      vi.setSystemTime(Date.now() + options.attachElapsedMs);
    }
    const pid = nextPid++;
    alive.add(pid);
    const transport: { pid: number | null } = { pid };
    const client = {
      callTool,
      close: vi.fn(async () => {
        alive.delete(pid);
        transport.pid = null;
      }),
    };
    return {
      transport,
      closeTransport: () => client.close(),
      processCleanup: { status: "open" as const },
      ready: Promise.resolve(),
      client,
    } as never;
  });
  setChromeMcpSessionFactoryForTest(factory);
  const ctx = createBrowserRouteContext({ getState: () => state });
  return { callTool, factory, listProcesses, profile, ctx };
}

describe("browser server-context listProfiles", () => {
  it("uses request-scoped cold probes and reuses a warm MCP session", async () => {
    const fixture = createExistingSessionProcessFixture();
    const { ctx } = fixture;
    await ctx.listProfiles();
    const profiles = await ctx.listProfiles();
    expect(profiles[0]).toMatchObject({ running: true, tabCount: 1 });
    expect(fixture.factory).toHaveBeenCalledTimes(2);
    expect(fixture.listProcesses).toHaveBeenCalledTimes(4);
    expect(fixture.callTool).toHaveBeenCalledWith(
      { name: "list_pages", arguments: {} },
      undefined,
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
    const fixture = createExistingSessionProcessFixture({ pageFailure: true });
    const { ctx } = fixture;
    const { app, getHandlers } = createBrowserRouteApp();
    registerBrowserBasicRoutes(app, ctx);
    const response = createBrowserRouteResponse();

    await getHandlers.get("/")?.(
      { params: {}, query: { profile: fixture.profile.name } },
      response.res,
    );

    expect(response.body).toMatchObject({ running: true, cdpReady: true, pageReady: false });
    expect(fixture.factory).toHaveBeenCalledOnce();

    const profiles = await ctx.listProfiles();
    expect(profiles[0]).toMatchObject({ running: true, tabCount: 0 });
    expect(fixture.factory).toHaveBeenCalledTimes(2);
  });

  it("times out a stuck status page probe within the budget remaining after attach", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    try {
      const fixture = createExistingSessionProcessFixture({
        attachElapsedMs: 3_000,
        hangingPage: true,
      });
      const { ctx } = fixture;
      const { app, getHandlers } = createBrowserRouteApp();
      registerBrowserBasicRoutes(app, ctx);
      const response = createBrowserRouteResponse();

      const pending = getHandlers.get("/")?.(
        { params: {}, query: { profile: fixture.profile.name } },
        response.res,
      );
      await vi.advanceTimersByTimeAsync(0);

      expect(fixture.callTool).toHaveBeenCalledWith(
        { name: "list_pages", arguments: {} },
        undefined,
        { signal: expect.any(AbortSignal), timeout: 4_000 },
      );
      await vi.advanceTimersByTimeAsync(3_999);
      expect(response.body).toBeUndefined();

      await vi.advanceTimersByTimeAsync(1);
      await pending;

      expect(response.statusCode).toBe(200);
      expect(response.body).toMatchObject({ running: true, cdpReady: true, pageReady: false });
      expect(fixture.factory).toHaveBeenCalledOnce();
      expect(fixture.listProcesses).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels one waiter while other probes observe the settled profile transition", async () => {
    const state = makeBrowserServerState();
    const ctx = createBrowserRouteContext({ getState: () => state });
    const profile = ctx.forProfile("openclaw");
    const runtime = expectDefined(state.profiles.get("openclaw"), "profile runtime");
    runtime.running = {
      pid: 123,
      exe: { kind: "chromium", path: "/usr/bin/chromium" },
      userDataDir: "/tmp/openclaw-profile",
      cdpPort: 18800,
      proc: {} as never,
    };
    const cleanup = createDeferred<void>();
    let transitionCompleted = false;
    const transition = beginProfileTransition({
      state,
      runtime,
      reason: "profile refresh requested",
      closeSharedAdapters: false,
      afterCleanup: async () => {
        await cleanup.promise;
        runtime.running = null;
        transitionCompleted = true;
      },
    });
    const isChromeCdpReady = vi.mocked(chromeModule.isChromeCdpReady);
    isChromeCdpReady.mockResolvedValue(true);
    vi.mocked(chromeModule.isChromeReachable).mockResolvedValue(false);

    const controller = new AbortController();
    const aborted = profile.isReachable(undefined, { signal: controller.signal });
    const surviving = profile.isReachable();
    const listing = ctx.listProfiles();
    let survivingCompleted = false;
    void surviving.then(() => {
      survivingCompleted = true;
    });

    const reason = new Error("profile request cancelled during transition");
    controller.abort(reason);

    try {
      await expect(aborted).rejects.toBe(reason);
      expect(transitionCompleted).toBe(false);
      expect(survivingCompleted).toBe(false);
      expect(isChromeCdpReady).not.toHaveBeenCalled();
    } finally {
      cleanup.resolve();
      await transition;
    }

    await expect(surviving).resolves.toBe(true);
    expect(survivingCompleted).toBe(true);
    await expect(profile.isReachable()).resolves.toBe(true);
    expect(isChromeCdpReady).toHaveBeenCalledTimes(2);
    expect((await listing)[0]?.running).toBe(false);
  });

  it("bypasses SSRF gating when probing managed loopback profiles", async () => {
    const state = makeBrowserServerState({
      resolvedOverrides: {
        ssrfPolicy: {},
      },
    });
    const isChromeReachable = vi.mocked(chromeModule.isChromeReachable);
    isChromeReachable.mockResolvedValue(true);

    const ctx = createBrowserRouteContext({ getState: () => state });
    const profiles = await ctx.listProfiles();

    expect(isChromeReachable).toHaveBeenCalledWith(
      "http://127.0.0.1:18800",
      200,
      undefined,
      expect.any(AbortSignal),
    );
    expect(profiles).toHaveLength(1);
    expect(profiles[0]?.name).toBe("openclaw");
    expect(profiles[0]?.running).toBe(true);
  });

  it("redacts CDP URL credentials from profile status", async () => {
    const state = makeBrowserServerState({
      profile: makeBrowserProfile({
        name: "manual-cdp",
        cdpUrl: "http://openclaw:relay-token@127.0.0.1:9222",
        cdpPort: 9222,
        color: "#00AA00",
        attachOnly: true,
      }),
      resolvedOverrides: {
        defaultProfile: "manual-cdp",
        ssrfPolicy: {},
      },
    });
    const isChromeReachable = vi.mocked(chromeModule.isChromeReachable);
    isChromeReachable.mockResolvedValue(true);

    const ctx = createBrowserRouteContext({ getState: () => state });
    const profiles = await ctx.listProfiles();

    expect(isChromeReachable).toHaveBeenCalledWith(
      "http://openclaw:relay-token@127.0.0.1:9222",
      state.resolved.remoteCdpTimeoutMs,
      undefined,
      expect.any(AbortSignal),
    );
    expect(profiles[0]).toMatchObject({
      name: "manual-cdp",
      running: true,
      cdpUrl: "http://127.0.0.1:9222",
    });
  });

  it("marks a runtime-only constructor profile as missing from config", async () => {
    const profileName = "constructor";
    const profile = makeBrowserProfile({ name: profileName });
    const state = makeBrowserServerState({
      profile,
      resolvedOverrides: { profiles: {} },
    });
    state.profiles.set(profileName, {
      profile,
      running: { pid: 123 } as never,
      lastTargetId: null,
    });

    const ctx = createBrowserRouteContext({ getState: () => state });
    const profiles = await ctx.listProfiles();

    expect(profiles).toHaveLength(1);
    expect(profiles[0]).toMatchObject({ name: profileName, missingFromConfig: true });
  });
});
