import "./server-context.chrome-test-harness.js";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
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

function createContext() {
  const state: BrowserServerState = {
    server: null,
    port: 18791,
    resolved: resolveBrowserConfig(config.current.browser, config.current),
    profiles: new Map(),
  };
  const ctx = createBrowserRouteContext({ getState: () => state, refreshConfigFromDisk: true });
  return { state, ctx };
}

function createLaunchFixture(beforeFirstLaunch = async () => {}) {
  const fixture = createContext();
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
      await beforeFirstLaunch();
      reachable = true;
      return original;
    })
    .mockImplementationOnce(async () => {
      reachable = true;
      return replacement;
    });
  return { ...fixture, original, replacement };
}

describe("browser inherited launch settings reload", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(launchOpenClawChrome).mockReset();
    config.current = {
      browser: {
        headless: true,
        defaultProfile: "openclaw",
        profiles: {
          openclaw: { cdpPort: 18800, color: "#FF4500" },
          attached: { cdpPort: 18801, color: "#0066CC", attachOnly: true },
          remote: { cdpUrl: "http://192.0.2.10:9222", color: "#00CC66" },
        },
      },
    };
  });

  it("keeps restart-owned controls while refreshing launch and cleanup settings", async () => {
    config.current.browser = {
      ...config.current.browser,
      ssrfPolicy: { allowedHostnames: ["192.0.2.10"] },
    };
    const { state, ctx } = createContext();
    const startup = state.resolved;
    vi.mocked(isChromeReachable).mockResolvedValue(true);
    await ctx.forProfile("remote").isHttpReachable();
    const startupProbePolicy = vi.mocked(isChromeReachable).mock.calls[0]?.[2];
    expect(startupProbePolicy).toMatchObject({ allowedHostnames: ["192.0.2.10"] });

    config.current.browser = {
      ...config.current.browser,
      noSandbox: true,
      enabled: false,
      evaluateEnabled: false,
      ssrfPolicy: { dangerouslyAllowPrivateNetwork: true },
      extensionRelay: { allowLegacyAuth: false },
      tabCleanup: { enabled: false },
    };
    await ctx.forProfile("remote").isHttpReachable();

    expect(vi.mocked(isChromeReachable).mock.lastCall?.[2]).toEqual(startupProbePolicy);
    expect(ctx.state().resolved).toMatchObject({
      noSandbox: true,
      enabled: startup.enabled,
      evaluateEnabled: startup.evaluateEnabled,
      extensionRelay: startup.extensionRelay,
      tabCleanup: { enabled: false },
    });
  });

  it("relaunches only owned Chrome when noSandbox changes", async () => {
    const change = { noSandbox: true };
    const { state, ctx, original, replacement } = createLaunchFixture();
    const attached = ctx.forProfile("attached");
    const remote = ctx.forProfile("remote");
    await attached.ensureBrowserAvailable();
    await remote.ensureBrowserAvailable();
    await ctx.forProfile().ensureBrowserAvailable();

    config.current = { ...config.current, browser: { ...config.current.browser, ...change } };
    await ctx.forProfile().ensureBrowserAvailable();

    expect(stopOpenClawChrome).toHaveBeenCalledExactlyOnceWith(original);
    expect(launchOpenClawChrome).toHaveBeenCalledTimes(2);
    expect(vi.mocked(launchOpenClawChrome).mock.calls[1]?.[0]).toMatchObject(change);
    expect(state.profiles.get("openclaw")?.running).toBe(replacement);
    await expect(attached.isReachable()).resolves.toBe(true);
    await expect(remote.isReachable()).resolves.toBe(true);
  });

  it("rejects a pending managed launch after extraArgs changes", async () => {
    const change = { extraArgs: ["--disable-dev-shm-usage"] };
    const started = createDeferred<void>();
    const release = createDeferred<void>();
    const {
      state,
      ctx,
      original: stale,
      replacement,
    } = createLaunchFixture(async () => {
      started.resolve();
      await release.promise;
    });
    const initialStart = ctx.forProfile().ensureBrowserAvailable();
    const outcome = initialStart.then(
      () => null,
      (error: unknown) => error,
    );
    await started.promise;
    config.current = { ...config.current, browser: { ...config.current.browser, ...change } };
    const nextProfile = ctx.forProfile();
    release.resolve();

    expect(await outcome).toBeInstanceOf(Error);
    expect(state.profiles.get("openclaw")?.running).not.toBe(stale);
    await nextProfile.ensureBrowserAvailable();
    expect(stopOpenClawChrome).toHaveBeenCalledExactlyOnceWith(stale);
    expect(vi.mocked(launchOpenClawChrome).mock.calls[1]?.[0]).toMatchObject(change);
    expect(state.profiles.get("openclaw")?.running).toBe(replacement);
  });
});
