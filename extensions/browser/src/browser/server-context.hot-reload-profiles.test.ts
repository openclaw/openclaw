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
import type { BrowserServerState } from "./server-context.types.js";

type TestProfileConfig = NonNullable<NonNullable<OpenClawConfig["browser"]>["profiles"]>[string];
const mockState = vi.hoisted(
  (): {
    cfgProfiles: Record<string, TestProfileConfig>;
  } => ({ cfgProfiles: {} }),
);
const { closePlaywright, retirePlaywright, stopChrome } = vi.hoisted(() => ({
  closePlaywright: vi.fn(async (_opts: { cdpUrl: string }) => {}),
  retirePlaywright: vi.fn((_opts: { cdpUrl: string }) => true),
  stopChrome: vi.fn(async () => {}),
}));

function buildConfig(): OpenClawConfig {
  return { browser: { headless: true, profiles: { ...mockState.cfgProfiles } } };
}

vi.mock("./config-refresh-source.js", () => ({
  loadBrowserConfigForRuntimeRefresh: () => buildConfig(),
}));

// mock-isolation: Exercise lifecycle ownership without starting a browser process.
vi.mock("./chrome.js", () => ({ stopOpenClawChrome: stopChrome }));

// mock-isolation: MCP transport is outside this profile lifecycle fixture.
vi.mock("./chrome-mcp.js", () => ({ closeChromeMcpSession: async () => false }));

// mock-isolation: Supply controlled connection retirement without loading Playwright.
vi.mock("./pw-ai-module.js", () => ({
  getLoadedPwAiModule: () => ({
    retirePlaywrightBrowserConnectionExact: (opts: { cdpUrl: string }) => ({
      retired: retirePlaywright(opts),
      close: async () => await closePlaywright(opts),
    }),
  }),
  getPwAiModule: async () => null,
}));

const { resolveBrowserConfig, resolveProfile } = await import("./config.js");
const { refreshResolvedBrowserConfigFromDisk } = await import("./resolved-config-refresh.js");

function createProfileFixture(
  name: string,
  config: TestProfileConfig,
  lastTargetId: string | null = null,
) {
  mockState.cfgProfiles[name] = config;
  const cfg = buildConfig();
  const state: BrowserServerState = {
    server: null,
    port: 18791,
    resolved: resolveBrowserConfig(cfg.browser, cfg),
    profiles: new Map(),
  };
  const profile = expectDefined(resolveProfile(state.resolved, name), `${name} profile missing`);
  const runtime = getOrCreateProfileRuntime(state, profile);
  runtime.lastTargetId = lastTargetId;
  return {
    state,
    profile,
    runtime,
    lifecycle: getProfileLifecycle(runtime),
    start: (run: (signal: AbortSignal) => Promise<void>) =>
      enqueueProfileStart({ state, runtime, key: "default", run }),
    update: (next: TestProfileConfig) => {
      mockState.cfgProfiles[name] = next;
      refreshProfiles(state);
    },
  };
}

function createExtensionRelayFixture(name = "chrome") {
  const fixture = createProfileFixture(name, { cdpPort: 18799, driver: "extension" }, "shared-tab");
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

describe("server-context hot-reload profiles", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    retirePlaywright.mockReturnValue(true);
    mockState.cfgProfiles = { openclaw: { cdpPort: 18800 } };
  });

  it("preserves live relay credentials across refreshes and retires them on port changes", async () => {
    const { state, runtime, relay, lifecycle, update } = createExtensionRelayFixture();
    const expectedUrl = runtime.profile.cdpUrl;
    Object.assign(state.resolved, {
      extensionRelayToken: relay.token,
      extensionRelayInternalTokens: {
        chrome: relay.internalToken,
        orphaned: "closed-relay-credential",
      },
    });

    for (let request = 0; request < 3; request += 1) {
      refreshProfiles(state);
      const resolved = resolveProfile(state.resolved, "chrome");

      expect(resolved?.cdpUrl).toBe(expectedUrl);
      expect(state.extensionRelays?.get("chrome")).toBe(relay);
      expect(state.resolved.extensionRelayInternalTokens).toEqual({ chrome: relay.internalToken });
      expect(state.resolved.extensionRelayToken).toBe(relay.token);
      expect(runtime.lastTargetId).toBe("shared-tab");
    }
    expect(relay.close).not.toHaveBeenCalled();
    update({ cdpPort: 18801, driver: "extension" });

    expect(state.resolved.extensionRelayInternalTokens).not.toHaveProperty("chrome");
    expect(runtime.profile.cdpPort).toBe(18801);
    expect(lifecycle.transitionReason).toContain("cdpPort");
    await lifecycle.tail;
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
    const { state, relay, close, lifecycle } = createExtensionRelayFixture();
    const closeStarted = createDeferred<void>();
    const closeReleased = createDeferred<void>();
    relay.close.mockImplementationOnce(async () => {
      closeStarted.resolve();
      await closeReleased.promise;
    });

    const closing = close();
    await closeStarted.promise;
    expect(lifecycle.transitionReason).toBeNull();

    refreshProfiles(state);
    expect(state.resolved.extensionRelayInternalTokens).not.toHaveProperty("chrome");

    closeReleased.resolve();
    await closing;
    await lifecycle.tail;
    expect(relay.close).toHaveBeenCalledOnce();
  });

  it("retires the adapter and stale selection when switching from Chromium to Lightpanda", async () => {
    const cdpUrl = "ws://127.0.0.1:9222/devtools/browser/engine-fixture";
    const { runtime, lifecycle, update } = createProfileFixture(
      "switchable",
      { engine: "chromium", cdpUrl, attachOnly: true },
      "old-target",
    );
    update({ engine: "lightpanda", cdpUrl, attachOnly: true });

    expect(runtime).toMatchObject({
      profile: { engine: "lightpanda", cdpUrl },
      lastTargetId: null,
    });
    expect(lifecycle.transitionReason).toBe("profile invariants changed: engine");
    expect(retirePlaywright).toHaveBeenCalledWith({ cdpUrl });
    await lifecycle.tail;
    expect(closePlaywright).toHaveBeenCalledWith({ cdpUrl });
    expect(stopChrome).not.toHaveBeenCalled();
  });

  it("reconciles existing-session command and structural argument changes", () => {
    const { lifecycle, update } = createProfileFixture("work", {
      cdpUrl: "http://127.0.0.1:9222",
      driver: "existing-session",
      mcpCommand: "/old/mcp",
      mcpArgs: ["--one"],
    });
    update({ ...mockState.cfgProfiles.work, mcpCommand: "/new/mcp", mcpArgs: ["--one", "--two"] });

    expect(lifecycle.transitionReason).toContain("mcpCommand");
    expect(lifecycle.transitionReason).toContain("mcpArgs");
  });

  it("rapid A to B to C closes both stale endpoints and adopts only C", async () => {
    const { state, profile, runtime, lifecycle, start, update } = createProfileFixture("work", {
      cdpPort: 18801,
    });
    const retired = new Set<string>();
    retirePlaywright.mockImplementation(({ cdpUrl }) => {
      const first = !retired.has(cdpUrl);
      retired.add(cdpUrl);
      return first;
    });

    update({ cdpPort: 18802 });
    const workB = expectDefined(resolveProfile(state.resolved, "work"), "work B missing");
    const adopted: string[] = [];
    const pendingB = start(async () => {
      adopted.push(workB.cdpUrl);
    });

    update({ cdpPort: 18803 });
    const workC = expectDefined(resolveProfile(state.resolved, "work"), "work C missing");
    expect(runtime.profile.cdpUrl).toBe(workC.cdpUrl);

    await expect(pendingB).rejects.toThrow(/profile invariants changed/i);
    await lifecycle.tail;
    await expect(
      start(async () => {
        adopted.push(runtime.profile.cdpUrl);
      }),
    ).resolves.toBeUndefined();

    expect(closePlaywright.mock.calls).toEqual([
      [{ cdpUrl: profile.cdpUrl }],
      [{ cdpUrl: workB.cdpUrl }],
    ]);
    expect(adopted).toEqual([workC.cdpUrl]);
  });

  it("keeps a removed-name tombstone until a pending start cleans its late handle", async () => {
    const { state, profile, runtime, lifecycle, start, update } = createProfileFixture(
      "constructor",
      { cdpPort: 18801 },
    );
    expect(runtime.running).toBeNull();
    const lateRunning = { pid: 321 } as RunningChrome;
    const launch = createDeferred<void>();
    const launchStarted = createDeferred<void>();
    const pendingStart = start(async () => {
      launchStarted.resolve();
      await launch.promise;
      lifecycle.handles.add(lateRunning);
    });
    await launchStarted.promise;

    Reflect.deleteProperty(mockState.cfgProfiles, "constructor");
    refreshProfiles(state);
    expect(lifecycle.terminal).toBe("config-removed");
    expect(state.profiles.get("constructor")).toBe(runtime);

    update({ cdpPort: 18802 });
    const workB = expectDefined(resolveProfile(state.resolved, "constructor"), "work B missing");
    expect(getOrCreateProfileRuntime(state, workB)).toBe(runtime);
    expect(() => start(async () => {})).toThrow(/config-removed/);

    launch.resolve();
    await expect(pendingStart).rejects.toThrow(/config-removed|lifecycle changed/i);
    await lifecycle.tail;
    await Promise.resolve();
    expect(state.profiles.has("constructor")).toBe(false);
    expect(stopChrome).toHaveBeenCalledExactlyOnceWith(lateRunning);
    const replacement = getOrCreateProfileRuntime(state, workB);
    expect(replacement).not.toBe(runtime);
    await expect(
      enqueueProfileStart({ state, runtime: replacement, key: "default", run: async () => {} }),
    ).resolves.toBeUndefined();
    expect(closePlaywright).toHaveBeenCalledWith({
      cdpUrl: profile.cdpUrl,
    });
  });
});
