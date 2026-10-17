// Browser tests cover extension-tab cleanup through live runtime-owned credentials.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { setRuntimeConfigSnapshot } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getBrowserStateRuntime } from "../browser-runtime-state.js";
import { resolveBrowserConfig, type ResolvedBrowserConfig } from "./config.js";
import { BROWSER_TAB_UNREACHABLE_RETIRE_MS } from "./constants.js";
import { browserSessionTabNativeIdentity } from "./session-tab-identity.js";
import { readColdNativeActivity } from "./session-tab-process-state.js";
import {
  closeTrackedBrowserTabsForSessions,
  sweepTrackedBrowserTabs,
  touchSessionBrowserTab,
  trackSessionBrowserTab,
  untrackSessionBrowserTab,
} from "./session-tab-registry.js";
import {
  cdpMocks,
  installSessionTabRegistrySqliteHarness,
} from "./session-tab-registry.sqlite.test-harness.js";
import { durableOwnership } from "./session-tab-registry.sqlite.test-helpers.js";

const config = {
  browser: {
    defaultProfile: "chrome",
    profiles: {
      chrome: { driver: "extension", cdpPort: 18_799, color: "#123456" },
    },
  },
} satisfies OpenClawConfig;

describe("durable extension session tab cleanup", () => {
  const { openStore } = installSessionTabRegistrySqliteHarness();
  let resolved: ResolvedBrowserConfig;
  beforeEach(() => {
    setRuntimeConfigSnapshot(config, config);
    resolved = resolveBrowserConfig(config.browser, config);
  });

  async function trackColdSiblings(nativeTargetId: string) {
    const params = {
      sessionKey: `agent:main:${nativeTargetId.toLowerCase()}`,
      targetId: nativeTargetId,
      profile: "chrome",
    };
    const firstOwnership = durableOwnership(nativeTargetId, "profile-a", "browser-a");
    const lastOwnership = durableOwnership(nativeTargetId, "profile-b", "browser-b");
    for (const ownership of [firstOwnership, lastOwnership]) {
      await trackSessionBrowserTab({ ...params, ownership, now: 1_000 });
    }
    // Both real durable generations own this alias, so activity cannot adopt either row.
    await touchSessionBrowserTab({ ...params, now: 2_000 });
    const coldIdentity = browserSessionTabNativeIdentity({ ...params, nativeTargetId });
    expect(readColdNativeActivity(coldIdentity)).toBe(2_000);
    return { params, firstOwnership, lastOwnership, coldIdentity };
  }

  it.each(["deletion", "replacement", "replacement with unavailable retirement"] as const)(
    "retires cold activity after the final native owner's %s",
    async (retirement) => {
      const { params, firstOwnership, lastOwnership, coldIdentity } =
        await trackColdSiblings("NATIVE-RETIRE");
      await untrackSessionBrowserTab({ ...params, ownership: firstOwnership });
      expect(openStore().entries()).toHaveLength(1);
      expect(readColdNativeActivity(coldIdentity)).toBe(2_000);

      if (retirement === "deletion") {
        await untrackSessionBrowserTab({ ...params, ownership: lastOwnership });
        expect(openStore().entries()).toEqual([]);
      } else {
        const unavailable = retirement === "replacement with unavailable retirement";
        const store = getBrowserStateRuntime().sessionTabs;
        const bind = store.withCurrent!;
        const reads = vi.fn(async () => {
          throw new Error("retirement read unavailable");
        });
        const observer = unavailable
          ? vi.spyOn(store, "withCurrent").mockImplementation((authority) => ({
              ...bind(authority),
              entries: reads,
            }))
          : undefined;
        try {
          await expect(
            trackSessionBrowserTab({
              ...params,
              ...(unavailable ? { profile: "renamed" } : { targetId: "opaque-handle" }),
              ownership: lastOwnership,
              now: 3_000,
            }),
          ).resolves.toMatchObject({
            profile: unavailable ? "renamed" : "chrome",
            interactionTargetKind: unavailable ? "native" : "opaque",
          });
        } finally {
          observer?.mockRestore();
        }
        expect(openStore().entries()).toHaveLength(1);
        expect(openStore().entries()[0]?.value).toMatchObject({
          profile: unavailable ? "renamed" : "chrome",
          interactionTargetKind: unavailable ? "native" : "opaque",
        });
        if (unavailable) {
          expect(reads).toHaveBeenCalledOnce();
          expect(readColdNativeActivity(coldIdentity)).toBe(2_000);
          return;
        }
      }
      expect(readColdNativeActivity(coldIdentity)).toBeUndefined();
    },
  );

  it("retires cold activity after terminal cleanup and preserves retryable owners", async () => {
    const closed = await trackColdSiblings("NATIVE-CLOSED");
    const retryable = await trackColdSiblings("NATIVE-RETRYABLE");
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

  it("retains cleanup without a runtime and closes it after reconnect", async () => {
    await trackSessionBrowserTab({
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
      sweepTrackedBrowserTabs({ now: afterRetireAge + 1, idleMs: 1, getResolvedBrowserConfig }),
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
});
