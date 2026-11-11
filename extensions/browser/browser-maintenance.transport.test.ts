import type { AddressInfo } from "node:net";
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

it("closes owned tabs over their transports and rechecks claims after runtime lookup", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const requests: string[] = [];
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
    const control = await cdp.listenHttp((request, response) => {
      if (request.method === "DELETE") {
        requests.push(`${request.method} ${request.url}`);
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ ok: true }));
      } else {
        response.statusCode = 404;
        response.end("{}");
      }
    });
    const { config, store } = await setupMaintenance(state, cdpUrl);
    const sessionKey = "agent:main:transport-cleanup";
    const close = () => closeTrackedBrowserTabsForSessions({ sessionKeys: [sessionKey] });
    const forget = () =>
      registry.closeTrackedBrowserTabsForSessions({
        sessionKeys: [sessionKey],
        closeTab: async () => {},
      });
    const route = {
      kind: "browser-control" as const,
      baseUrl: `http://127.0.0.1:${(control.address() as AddressInfo).port}`,
    };
    const tabDefaults = { sessionKey, profile: "remote" };
    try {
      await registry.trackSessionBrowserTab({ ...tabDefaults, targetId: "volatile", route });
      await expect(close()).resolves.toBe(1);
      expect(requests).toEqual(["DELETE /tabs/volatile?targetIdMode=raw&profile=remote"]);

      for (const firstKind of ["sweep", "lifecycle"] as const) {
        const joined = { ...tabDefaults, targetId: `joined-${firstKind}`, route };
        await registry.trackSessionBrowserTab({ ...joined, now: 1_000 });
        const lifecycle = () =>
          registry.closeTrackedBrowserTabsForSessions({ sessionKeys: [sessionKey] });
        const sweep = () => registry.sweepTrackedBrowserTabs({ now: 20_000, idleMs: 1 });
        const before = requests.length;
        const first = firstKind === "sweep" ? sweep() : lifecycle();
        await Promise.resolve();
        expect(requests).toHaveLength(before);
        await registry.touchSessionBrowserTab({ ...joined, now: 11_000 });
        const second = firstKind === "sweep" ? lifecycle() : sweep();
        const results = await Promise.all([first, second]);
        expect.soft(results.reduce((total, closed) => total + closed, 0)).toBe(1);
        expect
          .soft(requests.slice(before))
          .toEqual([`DELETE /tabs/joined-${firstKind}?targetIdMode=raw&profile=remote`]);
        await forget();
      }

      const ownership = await resolveCdpTabOwnership({
        profileName: "remote",
        cdpUrl,
        nativeTargetId: "owned",
      });
      expect(ownership.status).toBe("durable");
      const tab = { ...tabDefaults, targetId: "owned", ownership };
      await registry.trackSessionBrowserTab({ ...tab, now: 1_000 });
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
      await expect(close()).resolves.toBe(0);
      expect(requests).toHaveLength(3);
      expect(closedTargets).toHaveLength(1);
    } finally {
      await forget();
      resetPluginStateStoreForTests();
    }
  });
});
