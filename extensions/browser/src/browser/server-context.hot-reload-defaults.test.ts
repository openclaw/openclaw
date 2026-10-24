import "./server-context.chrome-test-harness.js";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { expect, it, vi } from "vitest";
import { isChromeReachable, launchOpenClawChrome, stopOpenClawChrome } from "./chrome.js";
import { resolveBrowserConfig } from "./config.js";
import { createBrowserRouteContext, type BrowserServerState } from "./server-context.js";
import { mockLaunchedChrome } from "./server-context.test-harness.js";

const config = vi.hoisted(() => ({ current: {} as OpenClawConfig }));
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
  const state: BrowserServerState = {
    server: null,
    port: 18791,
    profiles: new Map(),
    resolved: resolveBrowserConfig(config.current.browser, config.current),
  };
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
  vi.mocked(launchOpenClawChrome)
    .mockImplementationOnce(async () => {
      started.resolve();
      if (pending) {
        await release.promise;
      }
      reachable = true;
      return original;
    })
    .mockImplementationOnce(async () => {
      reachable = true;
      return replacement;
    });
  return { state, ctx, original, replacement, started, release };
}

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
