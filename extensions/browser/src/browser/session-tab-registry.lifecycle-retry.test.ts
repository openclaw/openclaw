import { describe, expect, it } from "vitest";
import { installSessionTabRegistrySqliteHarness } from "./session-tab-registry.sqlite.test-harness.js";
import { durableOwnership as ownership } from "./session-tab-registry.sqlite.test-helpers.js";

describe("durable session tab lifecycle retries", () => {
  const { freshRegistry, openStore } = installSessionTabRegistrySqliteHarness();

  it.each([true, false])(
    "retries pending lifecycle cleanup with ordinary cleanup %s",
    async (ordinaryCleanup) => {
      const registry = await freshRegistry("lifecycle-retry");
      registry.trackSessionBrowserTab({
        sessionKey: "agent:subagent:ended",
        targetId: "opaque",
        profile: "remote",
        ownership: ownership("NATIVE-PENDING"),
        now: 1_000,
      });
      await expect(
        registry.closeTrackedBrowserTabsForSessions({
          sessionKeys: ["agent:subagent:ended"],
          now: 2_000,
          closeDurableTab: async () => ({
            status: "unavailable",
            reason: "target-lookup-failed",
          }),
        }),
      ).resolves.toBe(0);
      expect(openStore().entries()[0]?.value).toMatchObject({
        nativeTargetId: "NATIVE-PENDING",
        cleanupKind: "lifecycle",
        cleanupAttemptToken: expect.any(String),
      });
      registry.trackSessionBrowserTab({
        sessionKey: "agent:main:active",
        targetId: "active",
        profile: "remote",
        ownership: ownership("NATIVE-ACTIVE"),
        now: 1_000,
      });

      await expect(
        registry.sweepTrackedBrowserTabs({
          now: 10_000,
          ordinaryCleanup,
          sessionFilter: () => false,
          closeDurableTab: async (_tab, options) =>
            options.shouldClose() ? { status: "closed" } : { status: "cancelled" },
        }),
      ).resolves.toBe(1);
      expect(
        openStore()
          .entries()
          .map((entry) => entry.value),
      ).toEqual([expect.objectContaining({ nativeTargetId: "NATIVE-ACTIVE" })]);
    },
  );
});
