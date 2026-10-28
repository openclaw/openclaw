import "./server-context.chrome-test-harness.js";
import { once } from "node:events";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, expect, it, vi } from "vitest";
import * as cdpHelpers from "./cdp.helpers.js";
import {
  isChromeCdpReady,
  isChromeReachable,
  launchOpenClawChrome,
  stopOpenClawChrome,
} from "./chrome.js";
import { fetchBrowserJson } from "./client-fetch.js";
import { resolveBrowserConfig } from "./config.js";
import { createBrowserRouteContext } from "./server-context.js";
import { makeBrowserServerState, mockLaunchedChrome } from "./server-context.test-harness.js";

const config = vi.hoisted(() => ({ current: {} as OpenClawConfig }));
const service = vi.hoisted(() => ({
  context: vi.fn(),
  start: vi.fn(),
  state: vi.fn(),
  readTabs: vi.fn(),
}));
// mock-isolation: real service startup installs host relays and credentials.
vi.mock("../control-service.js", () => ({
  createBrowserControlContext: service.context,
  startBrowserControlServiceFromConfig: service.start,
  getBrowserControlState: service.state,
  stopBrowserControlService: vi.fn(async () => {}),
}));
vi.mock("./config-refresh-source.js", () => ({
  loadBrowserConfigForRuntimeRefresh: () => config.current,
}));
vi.mock("./pw-ai-module.js", () => ({
  getLoadedPwAiModule: () => null,
  getPwAiModule: async () => null,
}));
const profiles = {
  openclaw: { cdpPort: 18800, color: "#FF4500" },
  attached: { cdpPort: 18801, color: "#0066CC", attachOnly: true },
  remote: { cdpUrl: "http://192.0.2.10:9222", color: "#00CC66" },
};

function updateBrowser(change: OpenClawConfig["browser"]) {
  config.current = { ...config.current, browser: { ...config.current.browser, ...change } };
}
function createFixture(pending = false, initial: OpenClawConfig["browser"] = {}) {
  vi.clearAllMocks();
  vi.mocked(launchOpenClawChrome).mockReset();
  config.current = {
    browser: { headless: true, defaultProfile: "openclaw", profiles, ...initial },
  };
  const started = createDeferred<void>();
  const release = createDeferred<void>();
  const state = makeBrowserServerState({
    resolvedOverrides: resolveBrowserConfig(config.current.browser, config.current),
  });
  state.port = 18791;
  const ctx = createBrowserRouteContext({ getState: () => state, refreshConfigFromDisk: true });
  let reachable = false;
  vi.mocked(isChromeReachable).mockImplementation(async (url) =>
    url.includes(":18800") ? reachable : true,
  );
  vi.mocked(stopOpenClawChrome).mockImplementation(async () => {
    reachable = false;
  });
  const original = mockLaunchedChrome(vi.mocked(launchOpenClawChrome), 101);
  const replacement = mockLaunchedChrome(vi.mocked(launchOpenClawChrome), 102);
  const launches = [original];
  vi.mocked(launchOpenClawChrome).mockImplementation(async () => {
    const running = launches.shift() ?? replacement;
    if (running === original) {
      started.resolve();
      if (pending) {
        await release.promise;
      }
    }
    reachable = true;
    return running;
  });
  return { state, ctx, original, replacement, started, release };
}
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

it("refreshes launch and cleanup settings but keeps restart-owned controls", async () => {
  const initial = { ssrfPolicy: { allowedHostnames: ["192.0.2.10"] } };
  const { state, ctx } = createFixture(false, initial);
  const { enabled, evaluateEnabled, extensionRelay } = state.resolved;
  vi.mocked(isChromeReachable).mockResolvedValue(true);
  await ctx.forProfile("remote").isHttpReachable();
  const policy = vi.mocked(isChromeReachable).mock.calls[0]?.[2];
  expect(policy).toMatchObject({ allowedHostnames: ["192.0.2.10"] });
  updateBrowser({
    noSandbox: true,
    enabled: false,
    evaluateEnabled: false,
    ssrfPolicy: { dangerouslyAllowPrivateNetwork: true },
    extensionRelay: { allowLegacyAuth: false },
    tabCleanup: { enabled: false },
  });
  await ctx.forProfile("remote").isHttpReachable();
  expect(vi.mocked(isChromeReachable).mock.lastCall?.[2]).toEqual(policy);
  expect(ctx.state().resolved).toMatchObject({
    noSandbox: true,
    enabled,
    evaluateEnabled,
    extensionRelay,
    tabCleanup: { enabled: false },
  });
});

it.each([false, true])("replaces only owned Chrome (launch pending=%s)", async (pending) => {
  const change = pending ? { extraArgs: ["--disable-dev-shm-usage"] } : { noSandbox: true };
  const { state, ctx, original, replacement, started, release } = createFixture(pending);
  const attached = ctx.forProfile("attached");
  const remote = ctx.forProfile("remote");
  await attached.ensureBrowserAvailable();
  await remote.ensureBrowserAvailable();
  const initial = ctx.forProfile().ensureBrowserAvailable();
  const outcome = pending ? initial.catch((error: unknown) => error) : initial;
  if (pending) {
    await started.promise;
  } else {
    await outcome;
  }
  updateBrowser(change);
  const nextProfile = ctx.forProfile();
  release.resolve();
  if (pending) {
    expect(await outcome).toBeInstanceOf(Error);
    expect(state.profiles.get("openclaw")?.running).not.toBe(original);
  }
  await nextProfile.ensureBrowserAvailable();
  expect(stopOpenClawChrome).toHaveBeenCalledExactlyOnceWith(original);
  expect(launchOpenClawChrome).toHaveBeenCalledTimes(2);
  expect(vi.mocked(launchOpenClawChrome).mock.calls[1]?.[0]).toMatchObject(change);
  expect(state.profiles.get("openclaw")?.running).toBe(replacement);
  await expect(attached.isReachable()).resolves.toBe(true);
  await expect(remote.isReachable()).resolves.toBe(true);
});

const startBrowser = (signal?: AbortSignal) =>
  fetchBrowserJson("/start", { method: "POST", timeoutMs: 20_000, signal });
const readTabs = () => fetchBrowserJson("/tabs", { timeoutMs: 20_000 });
const startedResponse = { ok: true, profile: "openclaw" };
function coldStart() {
  vi.useFakeTimers();
  const fixture = createFixture(true);
  service.context.mockReturnValue(fixture.ctx);
  service.start.mockResolvedValue(fixture.state);
  service.state.mockReturnValue(fixture.state);
  service.readTabs.mockResolvedValue([]);
  vi.spyOn(cdpHelpers, "fetchJson").mockImplementation(service.readTabs);
  vi.mocked(isChromeCdpReady).mockResolvedValue(true);
  return {
    ...fixture,
    finish: async () => {
      await fixture.started.promise;
      await vi.advanceTimersByTimeAsync(31_000);
      fixture.release.resolve();
    },
  };
}
it("shares cold startup beyond the action budget even when its first caller cancels", async () => {
  const { started, finish, state, original } = coldStart();
  const caller = new AbortController();
  const first = startBrowser(caller.signal);
  const cancelled = expect(first).rejects.toThrow("caller deadline expired");
  await started.promise;
  setTimeout(() => caller.abort(new Error("caller deadline expired")), 10_000);
  await vi.advanceTimersByTimeAsync(10_000);
  await cancelled;
  const next = startBrowser();
  const tabs = readTabs().catch((error: unknown) => error);
  await finish();
  expect(await next).toEqual(startedResponse);
  expect(await tabs).toEqual({ running: true, tabs: [], canAutoResizeViewport: true });
  await expect(startBrowser()).resolves.toEqual(startedResponse);
  expect(state.profiles.get("openclaw")?.running).toBe(original);
  expect(launchOpenClawChrome).toHaveBeenCalledOnce();
});
it("enforces the action deadline after startup completes", async () => {
  const { finish } = coldStart();
  const start = startBrowser();
  await finish();
  await start;
  const reading = Promise.withResolvers<void>();
  const tabList = Promise.withResolvers<[]>();
  service.readTabs.mockImplementationOnce(() => {
    reading.resolve();
    return tabList.promise;
  });
  const expired = expect(readTabs()).rejects.toThrow("timed out");
  await reading.promise;
  await vi.advanceTimersByTimeAsync(20_000);
  tabList.resolve([]);
  await expired;
});
it("bounds a stuck launch with the service startup deadline", async () => {
  const { started, state } = coldStart();
  vi.mocked(launchOpenClawChrome).mockImplementationOnce(async (_resolved, _profile, options) => {
    const signal = options?.signal;
    if (!signal) {
      throw new Error("expected lifecycle-owned launch signal");
    }
    started.resolve();
    await once(signal, "abort");
    const reason: unknown = signal.reason;
    throw reason instanceof Error ? reason : new Error("Browser startup aborted");
  });
  const expired = expect(startBrowser()).rejects.toThrow(
    'Browser startup for profile "openclaw" did not finish within 120000ms',
  );
  await started.promise;
  await vi.advanceTimersByTimeAsync(120_000);
  await expired;
  expect(state.profiles.get("openclaw")?.running).toBeNull();
});
