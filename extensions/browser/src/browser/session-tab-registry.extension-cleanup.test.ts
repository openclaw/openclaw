// Browser tests cover extension-tab cleanup through live runtime-owned credentials.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type {
  OpenKeyedStoreOptions,
  PluginStateSyncKeyedStore,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateKeyedStoreForTests,
  createPluginStateSyncKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerBrowserPlugin } from "../../plugin-registration.js";
import type { OpenClawPluginApi } from "../../runtime-api.js";
import { useAutoCleanupTempDirTracker } from "../../test-support.js";
import type { CloseTrackedCdpTargetResult } from "./cdp.helpers.js";
import { resolveBrowserConfig, type ResolvedBrowserConfig } from "./config.js";
import { BROWSER_TAB_UNREACHABLE_RETIRE_MS } from "./constants.js";
import { readColdNativeActivity } from "./session-tab-process-state.js";
import { durableOwnership } from "./session-tab-registry.sqlite.test-helpers.js";
import { browserSessionTabNativeIdentity } from "./session-tab-store.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const cdpMocks = vi.hoisted(() => ({
  closeTrackedCdpTarget: vi.fn<() => Promise<CloseTrackedCdpTargetResult>>(),
}));

vi.mock("./cdp.helpers.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./cdp.helpers.js")>()),
  closeTrackedCdpTarget: cdpMocks.closeTrackedCdpTarget,
}));

import {
  closeTrackedBrowserTabsForSessions,
  sweepTrackedBrowserTabs,
  touchSessionBrowserTab,
  trackSessionBrowserTab,
  untrackSessionBrowserTab,
} from "./session-tab-registry.js";

const config = {
  browser: {
    defaultProfile: "chrome",
    profiles: {
      chrome: {
        driver: "extension",
        cdpPort: 18_799,
        color: "#123456",
      },
    },
  },
} satisfies OpenClawConfig;

function clearProcessLocalTabState(): void {
  const state = globalThis as Record<symbol, unknown>;
  for (const name of [
    "openclaw.browser.session-tabs.volatile",
    "openclaw.browser.session-tabs.volatile-cleanup",
    "openclaw.browser.session-tabs.active-durable-keys",
    "openclaw.browser.session-tabs.cold-native-activity",
    "openclaw.browser.session-tabs.interaction-storage-keys",
    "openclaw.browser.session-tabs.exact-interaction-storage-keys",
    "openclaw.browser.session-tabs.volatile-aliases",
    "openclaw.browser.session-tabs.exact-volatile-aliases",
  ]) {
    delete state[Symbol.for(name)];
  }
}

function installRuntime(): void {
  registerBrowserPlugin(
    createTestPluginApi({
      id: "browser",
      name: "Browser",
      source: "test",
      rootDir: "/plugins/browser",
      config: {},
      runtime: {
        state: {
          openKeyedStore: (options: OpenKeyedStoreOptions) =>
            createPluginStateKeyedStoreForTests("browser", options),
          openSyncKeyedStore: (options: OpenKeyedStoreOptions) =>
            createPluginStateSyncKeyedStoreForTests("browser", options),
        },
      } as unknown as OpenClawPluginApi["runtime"],
    }),
  );
}

function openStore(): PluginStateSyncKeyedStore<unknown> {
  return createPluginStateSyncKeyedStoreForTests("browser", {
    namespace: "browser.session-tabs",
    maxEntries: 5_000,
    overflowPolicy: "reject-new",
  });
}

describe("durable extension session tab cleanup", () => {
  const originalStateDir = process.env.OPENCLAW_STATE_DIR;
  let resolved: ResolvedBrowserConfig;

  beforeEach(() => {
    clearRuntimeConfigSnapshot();
    clearProcessLocalTabState();
    process.env.OPENCLAW_STATE_DIR = tempDirs.make("openclaw-browser-extension-tabs-");
    resetPluginStateStoreForTests();
    installRuntime();
    openStore().clear();
    cdpMocks.closeTrackedCdpTarget.mockReset().mockResolvedValue({ status: "closed" });
    setRuntimeConfigSnapshot(config, config);
    resolved = resolveBrowserConfig(config.browser, config);
  });

  afterEach(() => {
    clearRuntimeConfigSnapshot();
    clearProcessLocalTabState();
    resetPluginStateStoreForTests();
    if (originalStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = originalStateDir;
    }
  });

  function trackColdSiblings(nativeTargetId: string) {
    const params = {
      sessionKey: `agent:main:${nativeTargetId.toLowerCase()}`,
      targetId: nativeTargetId,
      profile: "chrome",
    };
    const firstOwnership = durableOwnership(nativeTargetId, "profile-a", "browser-a");
    const lastOwnership = durableOwnership(nativeTargetId, "profile-b", "browser-b");
    for (const ownership of [firstOwnership, lastOwnership]) {
      trackSessionBrowserTab({ ...params, ownership, now: 1_000 });
    }
    // Both real durable generations own this alias, so activity cannot adopt either row.
    touchSessionBrowserTab({ ...params, now: 2_000 });
    const coldIdentity = browserSessionTabNativeIdentity({ ...params, nativeTargetId });
    expect(readColdNativeActivity(coldIdentity)).toBe(2_000);
    return { params, firstOwnership, lastOwnership, coldIdentity };
  }

  it.each(["deletion", "replacement"] as const)(
    "retires cold activity after the final native owner's %s",
    (retirement) => {
      const { params, firstOwnership, lastOwnership, coldIdentity } =
        trackColdSiblings("NATIVE-RETIRE");
      untrackSessionBrowserTab({ ...params, ownership: firstOwnership });
      expect(openStore().entries()).toHaveLength(1);
      expect(readColdNativeActivity(coldIdentity)).toBe(2_000);

      if (retirement === "deletion") {
        untrackSessionBrowserTab({ ...params, ownership: lastOwnership });
        expect(openStore().entries()).toEqual([]);
      } else {
        trackSessionBrowserTab({
          ...params,
          targetId: "opaque-handle",
          ownership: lastOwnership,
          now: 3_000,
        });
        expect(openStore().entries()).toHaveLength(1);
        expect(openStore().entries()[0]?.value).toMatchObject({ interactionTargetKind: "opaque" });
      }
      expect(readColdNativeActivity(coldIdentity)).toBeUndefined();
    },
  );

  it("retires cold activity after terminal cleanup and preserves retryable owners", async () => {
    const closed = trackColdSiblings("NATIVE-CLOSED");
    const retryable = trackColdSiblings("NATIVE-RETRYABLE");
    await expect(
      closeTrackedBrowserTabsForSessions({
        sessionKeys: [closed.params.sessionKey, retryable.params.sessionKey],
        now: 3_000,
        closeDurableTab: async (tab) =>
          tab.nativeTargetId === closed.params.targetId
            ? { status: "closed" }
            : { status: "unavailable", reason: "target-lookup-failed" },
      }),
    ).resolves.toBe(2);
    expect(openStore().entries()).toHaveLength(2);
    expect(readColdNativeActivity(retryable.coldIdentity)).toBe(2_000);
    expect(readColdNativeActivity(closed.coldIdentity)).toBeUndefined();
  });

  it("uses the live process-only extension credential for lifecycle cleanup", async () => {
    expect(resolved.extensionRelayInternalTokens).toEqual({});
    trackSessionBrowserTab({
      sessionKey: "agent:main:main",
      targetId: "extension-tab",
      profile: "chrome",
      ownership: durableOwnership("NATIVE-EXTENSION"),
      now: 1_000,
    });
    const internalToken = "process-only-test-credential";
    const liveResolved: ResolvedBrowserConfig = {
      ...resolved,
      extensionRelayInternalTokens: { chrome: internalToken },
    };
    expect(JSON.stringify(openStore().entries())).not.toContain(internalToken);

    await expect(
      closeTrackedBrowserTabsForSessions({
        sessionKeys: ["agent:main:main"],
        getResolvedBrowserConfig: () => liveResolved,
      }),
    ).resolves.toBe(1);
    expect(cdpMocks.closeTrackedCdpTarget).toHaveBeenCalledWith(
      expect.objectContaining({
        profileName: "chrome",
        cdpUrl: `http://openclaw-internal:${internalToken}@127.0.0.1:18799`,
        nativeTargetId: "NATIVE-EXTENSION",
      }),
    );
    expect(openStore().entries()).toEqual([]);
  });

  it("retains cleanup without a runtime and closes it after reconnect", async () => {
    trackSessionBrowserTab({
      sessionKey: "agent:main:main",
      targetId: "extension-tab",
      profile: "chrome",
      ownership: durableOwnership("NATIVE-EXTENSION"),
      now: 1_000,
    });
    let liveResolved: ResolvedBrowserConfig | null = null;
    const warnings: string[] = [];
    const getResolvedBrowserConfig = () => liveResolved;
    const afterRetireAge = 1_000 + BROWSER_TAB_UNREACHABLE_RETIRE_MS;

    await expect(
      sweepTrackedBrowserTabs({
        now: afterRetireAge,
        idleMs: 1,
        getResolvedBrowserConfig,
        onWarn: (message) => warnings.push(message),
      }),
    ).resolves.toBe(0);
    expect(cdpMocks.closeTrackedCdpTarget).not.toHaveBeenCalled();
    expect(openStore().entries()).toHaveLength(1);
    expect(warnings).toContain(
      "deferred tracked browser tab NATIVE-EXTENSION: extension relay runtime unavailable",
    );

    const internalToken = "reconnected-process-only-credential";
    liveResolved = {
      ...resolved,
      extensionRelayInternalTokens: { chrome: internalToken },
    };
    await expect(
      sweepTrackedBrowserTabs({
        now: afterRetireAge + 1,
        idleMs: 1,
        getResolvedBrowserConfig,
      }),
    ).resolves.toBe(1);
    expect(cdpMocks.closeTrackedCdpTarget).toHaveBeenCalledWith(
      expect.objectContaining({
        cdpUrl: `http://openclaw-internal:${internalToken}@127.0.0.1:18799`,
      }),
    );
    expect(openStore().entries()).toEqual([]);
  });
});
