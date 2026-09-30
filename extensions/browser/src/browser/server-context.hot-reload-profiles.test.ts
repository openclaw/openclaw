import { expectDefined } from "@openclaw/normalization-core";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RunningChrome } from "./chrome.js";
import type { ExtensionRelayHandle } from "./extension-relay/relay-server.js";
import {
  beginProfileTransition,
  enqueueProfileStart,
  getProfileLifecycle,
  getOrCreateProfileRuntime,
} from "./server-context.lifecycle.js";
import type { BrowserServerState, ProfileRuntimeState } from "./server-context.types.js";

type TestProfileConfig = NonNullable<NonNullable<OpenClawConfig["browser"]>["profiles"]>[string];
const mockState = vi.hoisted(
  (): {
    cfgProfiles: Record<string, TestProfileConfig>;
  } => ({ cfgProfiles: {} }),
);
const lifecycleMocks = vi.hoisted(() => ({
  closeChromeMcpSession: vi.fn(async () => false),
  closePlaywrightBrowserConnection: vi.fn(async (_opts: { cdpUrl: string }) => {}),
  retirePlaywrightBrowserConnection: vi.fn((_opts: { cdpUrl: string }) => true),
  stopOpenClawChrome: vi.fn(async () => {}),
}));

function buildConfig(): OpenClawConfig {
  return {
    browser: {
      enabled: true,
      color: "#FF4500",
      headless: true,
      defaultProfile: "openclaw",
      profiles: { ...mockState.cfgProfiles },
    },
  };
}

vi.mock("./config-refresh-source.js", () => ({
  loadBrowserConfigForRuntimeRefresh: () => buildConfig(),
}));

vi.mock("./chrome.js", () => ({
  stopOpenClawChrome: lifecycleMocks.stopOpenClawChrome,
}));

vi.mock("./chrome-mcp.runtime.js", () => ({
  getChromeMcpModule: async () => ({
    closeChromeMcpSession: lifecycleMocks.closeChromeMcpSession,
  }),
}));

vi.mock("./pw-ai-module.js", () => ({
  getLoadedPwAiModule: () => ({
    retirePlaywrightBrowserConnectionExact: (opts: { cdpUrl: string }) => ({
      retired: lifecycleMocks.retirePlaywrightBrowserConnection(opts),
      close: async () => await lifecycleMocks.closePlaywrightBrowserConnection(opts),
    }),
  }),
  getPwAiModule: async () => null,
}));

const { resolveBrowserConfig, resolveProfile } = await import("./config.js");
const { refreshResolvedBrowserConfigFromDisk } = await import("./resolved-config-refresh.js");

function createBrowserState() {
  const cfg = buildConfig();
  const resolved = resolveBrowserConfig(cfg.browser, cfg);
  const state: BrowserServerState = {
    server: null,
    port: 18791,
    resolved,
    profiles: new Map(),
  };
  return { state };
}

function createProfileFixture(
  options: {
    name?: string;
    config?: TestProfileConfig;
    lastTargetId?: string | null;
  } = {},
) {
  const name = options.name ?? "openclaw";
  if (options.config) {
    mockState.cfgProfiles[name] = options.config;
  }
  const { state } = createBrowserState();
  const profile = expectDefined(resolveProfile(state.resolved, name), `${name} profile missing`);
  const runtime = getOrCreateProfileRuntime(state, profile);
  runtime.lastTargetId = options.lastTargetId ?? null;
  return { state, profile, runtime };
}

function createExtensionRelayFixture(name = "chrome") {
  const fixture = createProfileFixture({
    name,
    config: { cdpPort: 18799, driver: "extension" },
    lastTargetId: "shared-tab",
  });
  const relay = {
    ownership: "owned",
    port: 18799,
    token: "persistent-relay-test-key",
    allowLegacyAuth: true,
    internalToken: `${name}-process-only-credential`,
    bridge: {} as ExtensionRelayHandle["bridge"],
    close: vi.fn(async () => {}),
  } satisfies ExtensionRelayHandle;
  fixture.state.extensionRelays = new Map([[name, relay]]);
  fixture.state.resolved.extensionRelayInternalTokens = { [name]: relay.internalToken };
  fixture.runtime.profile = expectDefined(
    resolveProfile(fixture.state.resolved, name),
    `${name} extension profile missing`,
  );
  const close = () =>
    beginProfileTransition({
      state: fixture.state,
      runtime: fixture.runtime,
      reason: "extension relay stopped",
      closeRelay: true,
    });
  return { ...fixture, relay, close };
}

function refreshProfiles(state: BrowserServerState) {
  refreshResolvedBrowserConfigFromDisk({ current: state, refreshConfigFromDisk: true });
}

function updateProfile(state: BrowserServerState, name: string, config: TestProfileConfig) {
  mockState.cfgProfiles[name] = config;
  refreshProfiles(state);
}

function enqueueCurrentProfileStart(
  state: BrowserServerState,
  runtime: ProfileRuntimeState,
  run: (signal: AbortSignal, generation: number) => Promise<void>,
) {
  return enqueueProfileStart({
    state,
    runtime,
    configRevision: getProfileLifecycle(runtime).configRevision,
    key: "default",
    run,
  });
}

describe("server-context hot-reload profiles", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    lifecycleMocks.closeChromeMcpSession.mockResolvedValue(false);
    lifecycleMocks.closePlaywrightBrowserConnection.mockResolvedValue(undefined);
    lifecycleMocks.retirePlaywrightBrowserConnection.mockReturnValue(true);
    lifecycleMocks.stopOpenClawChrome.mockResolvedValue(undefined);
    mockState.cfgProfiles = {
      openclaw: { cdpPort: 18800, color: "#FF4500" },
    };
  });

  it("preserves live relay credentials across refreshes and retires them on port changes", async () => {
    const { state, runtime, relay } = createExtensionRelayFixture();
    const expectedUrl = runtime.profile.cdpUrl;
    state.resolved = {
      ...state.resolved,
      extensionRelayToken: relay.token,
      extensionRelayInternalTokens: {
        chrome: relay.internalToken,
        orphaned: "closed-relay-credential",
      },
    };

    for (let request = 0; request < 3; request += 1) {
      refreshProfiles(state);
      const resolved = resolveProfile(state.resolved, "chrome");

      expect(resolved?.cdpUrl).toBe(expectedUrl);
      expect(state.extensionRelays?.get("chrome")).toBe(relay);
      expect(state.resolved.extensionRelayInternalTokens).toEqual({
        chrome: relay.internalToken,
      });
      expect(state.resolved.extensionRelayToken).toBe(relay.token);
      expect(getProfileLifecycle(runtime).configRevision).toBe(0);
      expect(runtime.lastTargetId).toBe("shared-tab");
    }
    expect(relay.close).not.toHaveBeenCalled();
    updateProfile(state, "chrome", { cdpPort: 18801, driver: "extension" });

    expect(state.resolved.extensionRelayInternalTokens).not.toHaveProperty("chrome");
    expect(runtime.profile.cdpPort).toBe(18801);
    expect(getProfileLifecycle(runtime).transitionReason).toContain("cdpPort");
    await getProfileLifecycle(runtime).tail;
    expect(relay.close).toHaveBeenCalledOnce();
    expect(state.extensionRelays?.has("chrome")).toBe(false);
  });

  it("retains relay credentials after failed cleanup and revokes only the successfully closed owner", async () => {
    const { state, relay, close } = createExtensionRelayFixture();
    state.resolved.extensionRelayInternalTokens.work = "other-live-profile-credential";
    relay.close.mockRejectedValueOnce(new Error("relay still listening"));
    await expect(close()).rejects.toThrow("relay still listening");
    expect(state.extensionRelays?.get("chrome")).toBe(relay);
    expect(state.resolved.extensionRelayInternalTokens.chrome).toBe(relay.internalToken);
    await close();

    expect(relay.close).toHaveBeenCalledTimes(2);
    expect(state.extensionRelays?.has("chrome")).toBe(false);
    expect(state.resolved.extensionRelayInternalTokens).toEqual({
      work: "other-live-profile-credential",
    });
  });

  it("preserves a replacement relay credential when an older handle finishes closing", async () => {
    const { state, relay, close } = createExtensionRelayFixture();
    const replacement = {
      ...relay,
      internalToken: "replacement-process-only-credential",
      close: vi.fn(async () => {}),
    } satisfies ExtensionRelayHandle;
    relay.close.mockImplementationOnce(async () => {
      state.extensionRelays?.set("chrome", replacement);
      state.resolved = {
        ...state.resolved,
        extensionRelayInternalTokens: { chrome: replacement.internalToken },
      };
    });

    await close();

    expect(state.extensionRelays?.get("chrome")).toBe(replacement);
    expect(state.resolved.extensionRelayInternalTokens.chrome).toBe(replacement.internalToken);
    expect(replacement.close).not.toHaveBeenCalled();
  });

  it("never re-adopts a relay credential while an unexposed close is still pending", async () => {
    const { state, runtime, relay, close } = createExtensionRelayFixture();
    const closeStarted = createDeferred<void>();
    const closeReleased = createDeferred<void>();
    relay.close.mockImplementationOnce(async () => {
      closeStarted.resolve();
      await closeReleased.promise;
    });

    const closing = close();
    await closeStarted.promise;
    expect(getProfileLifecycle(runtime).transitionReason).toBeNull();

    refreshProfiles(state);
    expect(state.resolved.extensionRelayInternalTokens).not.toHaveProperty("chrome");

    closeReleased.resolve();
    await closing;
    await getProfileLifecycle(runtime).tail;
    expect(relay.close).toHaveBeenCalledOnce();
  });

  it("retires the adapter and stale selection when switching from Chromium to Lightpanda", async () => {
    const cdpUrl = "ws://127.0.0.1:9222/devtools/browser/engine-fixture";
    const { state, runtime } = createProfileFixture({
      name: "switchable",
      config: { engine: "chromium", cdpUrl, attachOnly: true },
      lastTargetId: "old-target",
    });
    updateProfile(state, "switchable", { engine: "lightpanda", cdpUrl, attachOnly: true });

    expect(runtime.profile.engine).toBe("lightpanda");
    expect(runtime.profile.cdpUrl).toBe(cdpUrl);
    expect(runtime.lastTargetId).toBeNull();
    expect(getProfileLifecycle(runtime).transitionReason).toBe(
      "profile invariants changed: engine",
    );
    expect(lifecycleMocks.retirePlaywrightBrowserConnection).toHaveBeenCalledWith({ cdpUrl });
    await getProfileLifecycle(runtime).tail;
    expect(lifecycleMocks.closePlaywrightBrowserConnection).toHaveBeenCalledWith({ cdpUrl });
    expect(lifecycleMocks.stopOpenClawChrome).not.toHaveBeenCalled();
  });

  it("reconciles existing-session command and structural argument changes", () => {
    const { state, runtime } = createProfileFixture({
      name: "work",
      config: {
        cdpUrl: "http://127.0.0.1:9222",
        color: "#0066CC",
        driver: "existing-session",
        mcpCommand: "/old/mcp",
        mcpArgs: ["--one"],
      },
    });

    updateProfile(state, "work", {
      ...mockState.cfgProfiles.work,
      mcpCommand: "/new/mcp",
      mcpArgs: ["--one", "--two"],
    });

    expect(getProfileLifecycle(runtime).transitionReason).toContain("mcpCommand");
    expect(getProfileLifecycle(runtime).transitionReason).toContain("mcpArgs");
    expect(getProfileLifecycle(runtime).configRevision).toBe(1);
  });

  it("rapid A to B to C closes both stale endpoints and adopts only C", async () => {
    const { state, profile, runtime } = createProfileFixture({
      name: "work",
      config: { cdpPort: 18801, color: "#0066CC" },
    });
    const retired = new Set<string>();
    lifecycleMocks.retirePlaywrightBrowserConnection.mockImplementation(({ cdpUrl }) => {
      if (retired.has(cdpUrl)) {
        return false;
      }
      retired.add(cdpUrl);
      return true;
    });

    updateProfile(state, "work", { cdpPort: 18802, color: "#00AA00" });
    const workB = expectDefined(resolveProfile(state.resolved, "work"), "work B missing");
    const adopted: string[] = [];
    const pendingB = enqueueCurrentProfileStart(state, runtime, async () => {
      adopted.push(workB.cdpUrl);
    });

    updateProfile(state, "work", { cdpPort: 18803, color: "#AA00AA" });
    const workC = expectDefined(resolveProfile(state.resolved, "work"), "work C missing");
    expect(runtime.profile.cdpUrl).toBe(workC.cdpUrl);

    await expect(pendingB).rejects.toThrow(/profile config changed|superseded/i);
    await getProfileLifecycle(runtime).tail;
    await expect(
      enqueueCurrentProfileStart(state, runtime, async () => {
        adopted.push(runtime.profile.cdpUrl);
      }),
    ).resolves.toBeUndefined();

    expect(lifecycleMocks.closePlaywrightBrowserConnection.mock.calls).toEqual([
      [{ cdpUrl: profile.cdpUrl }],
      [{ cdpUrl: workB.cdpUrl }],
    ]);
    expect(adopted).toEqual([workC.cdpUrl]);
  });

  it("keeps a removed-name tombstone until a pending start cleans its late handle", async () => {
    const {
      state,
      profile,
      runtime: oldRuntime,
    } = createProfileFixture({
      name: "constructor",
      config: { cdpPort: 18801, color: "#0066CC" },
    });
    expect(oldRuntime.running).toBeNull();
    const lateRunning = { pid: 321 } as RunningChrome;
    const launch = createDeferred<void>();
    const launchStarted = createDeferred<void>();
    const pendingStart = enqueueCurrentProfileStart(state, oldRuntime, async () => {
      launchStarted.resolve();
      await launch.promise;
      getProfileLifecycle(oldRuntime).handles.add(lateRunning);
    });
    await launchStarted.promise;

    Reflect.deleteProperty(mockState.cfgProfiles, "constructor");
    refreshProfiles(state);
    expect(getProfileLifecycle(oldRuntime).terminal).toBe("config-removed");
    expect(state.profiles.get("constructor")).toBe(oldRuntime);

    updateProfile(state, "constructor", { cdpPort: 18802, color: "#00AA00" });
    const workB = expectDefined(resolveProfile(state.resolved, "constructor"), "work B missing");
    expect(getOrCreateProfileRuntime(state, workB)).toBe(oldRuntime);
    expect(() => enqueueCurrentProfileStart(state, oldRuntime, async () => {})).toThrow(
      /config-removed/,
    );

    launch.resolve();
    await expect(pendingStart).rejects.toThrow(/config-removed|lifecycle changed/i);
    await getProfileLifecycle(oldRuntime).tail;
    await Promise.resolve();
    expect(state.profiles.has("constructor")).toBe(false);
    expect(lifecycleMocks.stopOpenClawChrome).toHaveBeenCalledExactlyOnceWith(lateRunning);
    const replacement = getOrCreateProfileRuntime(state, workB);
    expect(replacement).not.toBe(oldRuntime);
    await expect(
      enqueueCurrentProfileStart(state, replacement, async () => {}),
    ).resolves.toBeUndefined();
    expect(lifecycleMocks.closePlaywrightBrowserConnection).toHaveBeenCalledWith({
      cdpUrl: profile.cdpUrl,
    });
  });

  it("retries a failed removal tombstone before admitting a same-name re-add", async () => {
    const { state, runtime: oldRuntime } = createProfileFixture({
      name: "work",
      config: { cdpPort: 18801, color: "#0066CC" },
    });
    lifecycleMocks.closePlaywrightBrowserConnection
      .mockRejectedValueOnce(new Error("close failed"))
      .mockResolvedValue(undefined);
    lifecycleMocks.retirePlaywrightBrowserConnection
      .mockReturnValueOnce(true)
      .mockReturnValue(false);

    delete mockState.cfgProfiles.work;
    refreshProfiles(state);
    await getProfileLifecycle(oldRuntime).tail;
    expect(getProfileLifecycle(oldRuntime).blockedReason).toContain("cleanup failed");
    expect(state.profiles.get("work")).toBe(oldRuntime);

    updateProfile(state, "work", { cdpPort: 18802, color: "#00AA00" });
    await getProfileLifecycle(oldRuntime).tail;
    await Promise.resolve();

    expect(state.profiles.has("work")).toBe(false);
    expect(lifecycleMocks.closePlaywrightBrowserConnection).toHaveBeenCalledTimes(2);
  });

  it("retries failed invariant cleanup before admitting the updated profile", async () => {
    const { state, profile, runtime } = createProfileFixture({
      name: "work",
      config: { cdpPort: 18801, color: "#0066CC" },
    });
    lifecycleMocks.closePlaywrightBrowserConnection
      .mockRejectedValueOnce(new Error("close failed"))
      .mockResolvedValue(undefined);

    updateProfile(state, "work", { cdpPort: 18802, color: "#00AA00" });
    await getProfileLifecycle(runtime).tail;
    expect(getProfileLifecycle(runtime).blockedReason).toContain("cleanup failed");

    refreshProfiles(state);
    await getProfileLifecycle(runtime).tail;

    expect(getProfileLifecycle(runtime).blockedReason).toBeNull();
    expect(runtime.profile.cdpPort).toBe(18802);
    expect(lifecycleMocks.retirePlaywrightBrowserConnection).toHaveBeenCalledWith({
      cdpUrl: profile.cdpUrl,
    });
    expect(lifecycleMocks.closePlaywrightBrowserConnection).toHaveBeenCalledTimes(2);
    expect(lifecycleMocks.closePlaywrightBrowserConnection).toHaveBeenNthCalledWith(1, {
      cdpUrl: profile.cdpUrl,
    });
    expect(lifecycleMocks.closePlaywrightBrowserConnection).toHaveBeenNthCalledWith(2, {
      cdpUrl: profile.cdpUrl,
    });
    await expect(
      enqueueCurrentProfileStart(state, runtime, async () => {}),
    ).resolves.toBeUndefined();
  });
});
