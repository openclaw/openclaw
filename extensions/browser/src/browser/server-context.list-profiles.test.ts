import { expectDefined } from "@openclaw/normalization-core";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
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
import type { ResolvedBrowserProfile } from "./config.js";
import { ExtensionRelayBridge } from "./extension-relay/relay-bridge.js";
import type { ExtensionRelayHandle } from "./extension-relay/relay-server.js";
import { registerBrowserBasicRoutes } from "./routes/basic.js";
import { createBrowserRouteApp, createBrowserRouteResponse } from "./routes/test-helpers.js";
import { createBrowserRouteContext } from "./server-context.js";
import { beginProfileTransition } from "./server-context.lifecycle.js";
import {
  makeBrowserProfile,
  makeBrowserServerState,
  mockLaunchedChrome,
} from "./server-context.test-harness.js";
import type { BrowserServerState } from "./server-context.types.js";

const { mockChromeMcpProcesses } = await vi.hoisted(
  () => import("./chrome-mcp-process.test-support.js"),
);

const observationMocks = vi.hoisted(() => ({
  listPages: vi.fn(async () => []),
  ensureRelay: vi.fn(async (state: BrowserServerState, profile: ResolvedBrowserProfile) =>
    state.extensionRelays?.get(profile.name),
  ),
}));
vi.mock("./cdp.helpers.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./cdp.helpers.js")>()),
  fetchJson: vi.fn(async () => {
    throw new Error("no CDP HTTP listener");
  }),
}));
vi.mock("./pw-ai-module.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./pw-ai-module.js")>()),
  getPwAiModule: async () => ({ listPagesViaPlaywright: observationMocks.listPages }),
}));
vi.mock("./extension-relay.runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./extension-relay.runtime.js")>()),
  getExtensionRelayModule: async () => ({
    ensureExtensionRelayForProfile: observationMocks.ensureRelay,
  }),
}));

installChromeMcpSessionTestHooks();
beforeEach(() => getChromeMcpModule.clear());

afterEach(() => {
  getChromeMcpModule.clear();
  vi.clearAllMocks();
});

function createExistingSessionProcessFixture() {
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
  const callTool = vi.fn(async () => fakeListPagesResult());
  const factory = vi.fn(() => {
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

it("observes idle profiles without attaching and leaves attachment to explicit use", async () => {
  const fixture = createExistingSessionProcessFixture();
  const { ctx, response, status } = fixture;
  await status();
  expect(response.body).toMatchObject({ running: false, cdpReady: false, pageReady: false });
  expect((await ctx.listProfiles())[0]).toMatchObject({ running: false, tabCount: 0 });
  expect(fixture.factory).not.toHaveBeenCalled();
  expect(chromeModule.launchOpenClawChrome).not.toHaveBeenCalled();

  const profile = ctx.forProfile(fixture.profile.name).profile;
  await listChromeMcpTabs(profile.name, profile);
  fixture.callTool.mockClear();
  await status();
  expect(response.body).toMatchObject({ running: true, cdpReady: true, pageReady: true });
  expect((await ctx.listProfiles())[0]).toMatchObject({ running: true, tabCount: 1 });
  expect(fixture.factory).toHaveBeenCalledOnce();
  expect(fixture.callTool).not.toHaveBeenCalled();
});

it("reads extension profile metadata without creating a debugger client or tab aliases", async () => {
  const profile = makeBrowserProfile({ name: "chrome", driver: "extension", attachOnly: true });
  const state = makeBrowserServerState({ profile });
  const bridge = new ExtensionRelayBridge();
  onTestFinished(() => bridge.dispose());
  const socket = { send: vi.fn(), close: vi.fn() };
  bridge.attachExtensionSocket(socket).onMessage(
    JSON.stringify({
      type: "hello",
      browserVersion: "Chrome/test",
      userAgent: "browser-test",
      extensionVersion: "2",
      tabs: [{ tabId: 1, url: "https://example.com", title: "Example", active: true }],
    }),
  );
  state.extensionRelays = new Map([
    [
      profile.name,
      {
        ownership: "owned",
        port: profile.cdpPort,
        token: "test-relay-key",
        internalToken: "test-internal-key",
        allowLegacyAuth: true,
        bridge,
        close: async () => bridge.dispose(),
      } satisfies ExtensionRelayHandle,
    ],
  ]);
  const ctx = createBrowserRouteContext({ getState: () => state });
  const profiles = await ctx.listProfiles();
  expect(observationMocks.listPages).not.toHaveBeenCalled();
  expect(observationMocks.ensureRelay).not.toHaveBeenCalled();
  expect(profiles[0]).toMatchObject({ name: "chrome", running: true, tabCount: 1 });
  expect(state.profiles.get("chrome")?.tabAliases).toBeUndefined();
  expect(bridge.cdpClientCount).toBe(0);
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
