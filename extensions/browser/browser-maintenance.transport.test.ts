import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { withOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { assert, expect, it, onTestFinished } from "vitest";
import { closeTrackedBrowserTabsForSessions } from "./browser-maintenance.js";
import { setupMaintenance } from "./browser-maintenance.test-support.js";
import { resolveCdpTabOwnership } from "./src/browser/cdp.helpers.js";
import { createCdpFixture, cdpResult } from "./src/browser/cdp.test-support.js";
import { resolveBrowserConfig } from "./src/browser/config.js";
import * as registry from "./src/browser/session-tab-registry.js";

it("rechecks durable claims after runtime lookup before closing owned CDP targets", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const closedTargets: string[] = [];
    const targets = new Set(["owned", "user"]);
    const cdp = createCdpFixture({});
    onTestFinished(() => cdp.close());
    const { cdpUrl } = await cdp.start({
      "Target.getTargets": () =>
        cdpResult({ targetInfos: [...targets].map((targetId) => ({ targetId, type: "page" })) }),
      "Target.closeTarget": ({ params }) => {
        const targetId = params?.targetId;
        assert(typeof targetId === "string", "expected a string target ID");
        closedTargets.push(targetId);
        return cdpResult({ success: targets.delete(targetId) });
      },
    });
    const { config, store } = await setupMaintenance(state, cdpUrl);
    const sessionKey = "agent:main:transport-cleanup";
    const close = () => closeTrackedBrowserTabsForSessions({ sessionKeys: [sessionKey] });
    const tabDefaults = { sessionKey, profile: "remote", now: 1_000 };
    try {
      const ownership = await resolveCdpTabOwnership({
        profileName: "remote",
        cdpUrl,
        nativeTargetId: "owned",
      });
      const tab = { ...tabDefaults, targetId: "owned", ownership };
      await registry.trackSessionBrowserTab(tab);
      const resolved = resolveBrowserConfig(config.browser, config);
      const entered = createDeferred<void>();
      const release = createDeferred<void>();
      const sweep = registry.sweepTrackedBrowserTabs({
        now: 10_000,
        idleMs: 1,
        getResolvedBrowserConfig: async () => {
          entered.resolve();
          await release.promise;
          return resolved;
        },
      });
      try {
        await entered.promise;
        await registry.touchSessionBrowserTab({ ...tab, now: 11_000 });
      } finally {
        release.resolve();
      }
      await expect(sweep).resolves.toBe(0);
      expect(closedTargets).toEqual([]);
      const retained = await store.entries();
      expect(retained).toHaveLength(1);
      expect(retained[0]?.value).not.toHaveProperty("cleanupAttemptToken");

      await expect(close()).resolves.toBe(1);
      expect(closedTargets).toEqual(["owned"]);
      expect([...targets]).toEqual(["user"]);
      expect(await store.entries()).toEqual([]);
    } finally {
      await registry.closeTrackedBrowserTabsForSessions({
        sessionKeys: [sessionKey],
        closeTab: async () => {},
      });
      resetPluginStateStoreForTests();
    }
  });
});
