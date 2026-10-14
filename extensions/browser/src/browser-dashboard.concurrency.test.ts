import { setImmediate } from "node:timers/promises";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it, vi } from "vitest";
import {
  interceptStoreActions,
  useBrowserDashboardTestHarness,
} from "./browser-dashboard.test-harness.js";
import { closePageByTargetIdViaPlaywright } from "./browser/pw-session-actions.js";
import { closePageViaPlaywright } from "./browser/pw-tools-core.snapshot.js";
import {
  closeTrackedBrowserTabsForSessions,
  sweepTrackedBrowserTabs,
  trackSessionBrowserTab,
} from "./browser/session-tab-registry.js";
import { durableOwnership } from "./browser/session-tab-registry.sqlite.test-helpers.js";

const browser = vi.hoisted(() => ({
  open: vi.fn(),
  tabs: vi.fn(),
  ownership: vi.fn(),
  closeOwned: vi.fn(),
  page: vi.fn(),
}));
vi.mock("./browser/client.js", () => ({
  browserOpenTab: browser.open,
  browserTabs: browser.tabs,
}));
vi.mock("./browser/cdp.helpers.js", () => ({
  resolveCdpTabOwnership: browser.ownership,
  closeTrackedCdpTarget: browser.closeOwned,
}));
vi.mock("./browser/pw-session-page-target.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./browser/pw-session-page-target.js")>()),
  isConnectionScopedPage: () => false,
}));
vi.mock("./browser/pw-session-connection.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./browser/pw-session-connection.js")>()),
  getPageForTargetId: browser.page,
}));

import {
  reconcileBrowserDashboards,
  requestBrowserDashboard,
  stopBrowserDashboard,
} from "./browser-dashboard.js";
import {
  getBrowserSessionTabStore,
  readBrowserDashboardTabs,
} from "./browser/session-tab-store.js";

const sessionKey = "agent:main:browser-dashboard-proof";
const request = { sessionKey, agentId: "main", name: "service" };

describe("Browser dashboard operation ordering", () => {
  const fixture = useBrowserDashboardTestHarness(browser, sessionKey);

  it.each([
    { identity: "known", order: "close-first" },
    { identity: "unidentified", order: "close-first" },
    { identity: "known", order: "registration-first" },
    { identity: "unidentified", order: "registration-first" },
    { identity: "known", order: "preparation-first" },
    { identity: "unidentified", order: "preparation-first" },
  ] as const)(
    "orders $identity Playwright close and dashboard retention when $order",
    async ({ identity, order }) => {
      const paused = createDeferred<void>();
      const resume = createDeferred<void>();
      const mutationPrepared = createDeferred<void>();
      const closeRequested = createDeferred<void>();
      const targetOpened = createDeferred<void>();
      const finishOpen = createDeferred<void>();
      const finishClose = createDeferred<void>();
      let remainingReads = identity === "known" ? 1 : 2;
      let closeStarted = false;
      let holdMutation = order === "registration-first";
      const observer = interceptStoreActions((store) => ({
        ...store,
        entries: async () => {
          const entries = await store.entries();
          if (order === "close-first" && closeStarted && --remainingReads === 0) {
            paused.resolve();
            await resume.promise;
          }
          return entries;
        },
        observe: async (key) => {
          const result = await store.observe(key);
          mutationPrepared.resolve();
          if (holdMutation) {
            holdMutation = false;
            await resume.promise;
          }
          return result;
        },
      }));
      const close = vi.fn(async () => {
        await finishClose.promise;
        fixture.tabs = fixture.tabs.filter((tab) => tab.targetId !== "target-1");
      });
      browser.page.mockImplementation(async () => {
        expect(fixture.tabs.map((tab) => tab.targetId)).toContain("target-1");
        closeRequested.resolve();
        return { close };
      });
      if (order !== "registration-first") {
        browser.open.mockImplementationOnce(async () => {
          const tab = fixture.openedTab();
          if (order === "close-first") {
            targetOpened.resolve();
            await finishOpen.promise;
          } else {
            fixture.readBoard.mockImplementationOnce(async () => {
              paused.resolve();
              await resume.promise;
              return structuredClone({ sessionKey, widgets: fixture.widgets });
            });
          }
          return tab;
        });
      }
      const cdpUrl = "http://127.0.0.1:9222";
      const closePage = () =>
        identity === "known"
          ? closePageByTargetIdViaPlaywright({ cdpUrl, targetId: "target-1" })
          : closePageViaPlaywright({ cdpUrl });
      let closing: Promise<void> | undefined;
      let opened = false;
      const opening = requestBrowserDashboard(request).then((result) => {
        opened = true;
        return result;
      });
      try {
        if (order === "close-first") {
          await targetOpened.promise;
          expect(fixture.tabs.map((tab) => tab.targetId)).toEqual(["target-1"]);
          closeStarted = true;
          closing = closePage();
          await paused.promise;
          finishOpen.resolve();
        }
        if (order === "preparation-first") {
          await paused.promise;
          closing = closePage();
          await closeRequested.promise;
        } else {
          await mutationPrepared.promise;
        }
        if (order === "registration-first") {
          closing = closePage();
          await closeRequested.promise;
        }
        await trackSessionBrowserTab({
          sessionKey,
          targetId: "ordinary-tab",
          profile: "openclaw",
          ownership: durableOwnership("ordinary-tab"),
        });
        expect(opened).toBe(false);
        expect(await readBrowserDashboardTabs()).toEqual([]);
        if (order === "close-first") {
          resume.resolve();
          await expect(opening).rejects.toThrow("close was dispatched during registration");
          expect(opened).toBe(false);
          expect(close).toHaveBeenCalledOnce();
          finishClose.resolve();
          await closing;
          expect(fixture.tabs).toEqual([]);
          expect(await readBrowserDashboardTabs()).toEqual([]);
        } else {
          expect(close).not.toHaveBeenCalled();
          resume.resolve();
          await opening;
          finishClose.resolve();
          await expect(closing).rejects.toThrow(/dashboard|retained/);
          expect(close).not.toHaveBeenCalled();
          expect(opened).toBe(true);
          expect(fixture.tabs.map((tab) => tab.targetId)).toEqual(["target-1"]);
          expect((await readBrowserDashboardTabs())[0]?.nativeTargetId).toBe("target-1");
        }
      } finally {
        resume.resolve();
        finishOpen.resolve();
        finishClose.resolve();
        await Promise.allSettled([closing, opening]);
        observer.mockRestore();
      }
    },
  );

  it.each([
    { state: "active tab", changed: "caller", cleanupKind: "lifecycle", phase: "board" },
    { state: "Stop intent", changed: "caller", cleanupKind: "lifecycle", phase: "board" },
    { state: "active tab", changed: "prepared", cleanupKind: "lifecycle", phase: "board" },
    { state: "Stop intent", changed: "prepared", cleanupKind: "lifecycle", phase: "board" },
    { state: "active tab", changed: "runtime", cleanupKind: "lifecycle", phase: "board" },
    { state: "Stop intent", changed: "runtime", cleanupKind: "sweep", phase: "board" },
    { state: "active tab", changed: "runtime", cleanupKind: "lifecycle", phase: "store" },
    { state: "active tab", changed: "runtime", cleanupKind: "reconcile", phase: "store" },
    { state: "Stop intent", changed: "runtime", cleanupKind: "reconcile", phase: "intents" },
  ] as const)(
    "preserves a dashboard $state and successor tabs when $changed changes during $cleanupKind $phase read",
    async ({ state, changed, cleanupKind, phase }) => {
      if (state === "active tab") {
        await requestBrowserDashboard(request);
      } else {
        await stopBrowserDashboard(request);
      }
      fixture.widgets = [];
      const reading = createDeferred<void>();
      const finish = createDeferred<void>();
      const pauseRead = async () => {
        reading.resolve();
        await finish.promise;
      };
      let remainingReads = phase === "intents" ? 2 : 1;
      const storeRead =
        phase !== "board"
          ? interceptStoreActions((store) => ({
              ...store,
              entries: async () => {
                if (--remainingReads === 0) {
                  await pauseRead();
                }
                return await store.entries();
              },
            }))
          : undefined;
      if (phase === "board") {
        fixture.readBoard.mockImplementationOnce(async () => {
          await pauseRead();
          return { sessionKey, widgets: [] };
        });
      }
      let current = true;
      const closeTab = vi.fn(async () => {});
      const currency = {
        isCurrent: () => changed === "prepared" || current,
        ...(changed === "prepared" ? { prepareCurrent: async () => current } : {}),
      };
      const cleanup =
        cleanupKind === "lifecycle"
          ? closeTrackedBrowserTabsForSessions({
              sessionKeys: [sessionKey],
              ...currency,
              closeTab,
            })
          : cleanupKind === "sweep"
            ? sweepTrackedBrowserTabs({
                ordinaryCleanup: false,
                ...currency,
                closeTab,
              })
            : reconcileBrowserDashboards(currency);
      try {
        await reading.promise;
        if (changed === "runtime") {
          await fixture.installRuntime();
        } else {
          current = false;
        }
        await trackSessionBrowserTab({
          sessionKey,
          targetId: "successor-tab",
          profile: "openclaw",
          ownership: durableOwnership("successor-tab"),
        });
        const retained = await getBrowserSessionTabStore().entries();
        finish.resolve();
        await expect(cleanup).resolves.toBe(0);
        expect(await getBrowserSessionTabStore().entries()).toEqual(retained);
        expect(closeTab).not.toHaveBeenCalled();
        expect(browser.closeOwned).not.toHaveBeenCalled();

        await expect(
          closeTrackedBrowserTabsForSessions({ sessionKeys: [sessionKey], closeTab }),
        ).resolves.toBe(state === "active tab" ? 2 : 1);
        expect(await getBrowserSessionTabStore().entries()).toEqual([]);
      } finally {
        finish.resolve();
        storeRead?.mockRestore();
        await cleanup;
      }
    },
  );

  it("retires a claimed dashboard tab after the cleanup caller changes", async () => {
    await requestBrowserDashboard(request);
    fixture.widgets = [];
    const entered = createDeferred<void>();
    const finish = createDeferred<void>();
    let current = true;
    const closeTab = vi.fn(async () => {
      entered.resolve();
      await finish.promise;
    });
    const cleanup = closeTrackedBrowserTabsForSessions({
      sessionKeys: [sessionKey],
      isCurrent: () => current,
      prepareCurrent: async () => current,
      closeTab,
    });
    try {
      await Promise.race([entered.promise, cleanup]);
      expect(closeTab).toHaveBeenCalledOnce();
      current = false;
      finish.resolve();
      await expect(cleanup).resolves.toBe(1);
      expect(await getBrowserSessionTabStore().entries()).toEqual([]);
    } finally {
      finish.resolve();
      await cleanup;
    }
  });

  it.each(["definition updated", "stop after resume", "stop after normal open"] as const)(
    "keeps shared materialization failures scoped when %s",
    async (failure) => {
      const started = createDeferred<void>();
      const finish = createDeferred<void>();
      const followerRead = createDeferred<void>();
      const stopping = failure.startsWith("stop ");
      const cancelInitiator = failure === "stop after resume";
      browser.open.mockImplementation(async () => {
        await setImmediate();
        return fixture.openedTab();
      });
      browser.open.mockImplementationOnce(async () => {
        started.resolve();
        await finish.promise;
        return fixture.openedTab();
      });
      const initiator = new AbortController();
      const opening = requestBrowserDashboard(request, { signal: initiator.signal });
      await started.promise;
      if (failure === "definition updated") {
        fixture.widgets[0]!.props.url = "http://updated.example/";
        fixture.widgets[0]!.revision += 1;
      }
      fixture.readBoard.mockImplementationOnce(async () => {
        followerRead.resolve();
        return structuredClone({ sessionKey, widgets: fixture.widgets });
      });
      const waiting = requestBrowserDashboard({ ...request, resume: cancelInitiator });
      const settled = Promise.allSettled([opening, waiting]);
      await followerRead.promise;
      await setImmediate();
      const stopCall = stopping ? stopBrowserDashboard(request) : undefined;
      if (cancelInitiator) {
        initiator.abort(new Error("initiator cancelled"));
      }
      finish.resolve();
      const results = await settled;
      if (stopCall) {
        expect((await stopCall).paused).toBe(true);
        expect(results[0].status).toBe(cancelInitiator ? "rejected" : "fulfilled");
        expect(results[1].status).toBe("fulfilled");
        expect(fixture.tabs).toEqual([]);
        expect(
          (await readBrowserDashboardTabs()).some((tab) => tab.dashboard?.state === "active"),
        ).toBe(false);
        expect((await requestBrowserDashboard({ ...request, resume: true })).paused).toBe(false);
        expect(fixture.tabs).toHaveLength(1);
        return;
      }
      expect(results[0]).toMatchObject({
        status: "rejected",
        reason: { message: expect.stringContaining("changed during this operation") },
      });
      expect(results[1]).toMatchObject({
        status: "fulfilled",
        value: {
          browserTab: { targetId: "target-2" },
          url: "http://updated.example/",
          revision: 2,
        },
      });
      expect(browser.open).toHaveBeenCalledTimes(2);
      expect(fixture.tabs.map((tab) => tab.targetId)).toEqual(["target-2"]);
      expect(browser.open).toHaveBeenLastCalledWith(
        undefined,
        "http://updated.example/",
        expect.objectContaining({ profile: "openclaw" }),
      );
    },
  );

  it("resolves the current definition after a failed queued open", async () => {
    const started = createDeferred<void>();
    const finish = createDeferred<void>();
    const backendError = new Error("Chrome startup failed");
    browser.open.mockImplementationOnce(async () => {
      started.resolve();
      await finish.promise;
      throw backendError;
    });
    const opening = requestBrowserDashboard(request);
    await started.promise;
    const originalUrl = fixture.widgets[0]!.props.url;
    const updatedUrl = "http://updated.example/";
    fixture.widgets[0]!.props.url = updatedUrl;
    const waiting = requestBrowserDashboard(request);
    const following = requestBrowserDashboard(request);
    const settled = Promise.allSettled([opening, waiting, following]);
    await setImmediate();
    fixture.readBoard.mockImplementation(async () => {
      if ((await readBrowserDashboardTabs()).some((tab) => tab.dashboard?.url === updatedUrl)) {
        fixture.widgets[0]!.props.url = originalUrl;
      }
      return structuredClone({ sessionKey, widgets: fixture.widgets });
    });
    finish.resolve();
    const results = await settled;
    expect(results[0]).toEqual({ status: "rejected", reason: backendError });
    expect(results.slice(1)).toMatchObject([
      { status: "fulfilled", value: { url: updatedUrl } },
      { status: "fulfilled", value: { url: originalUrl } },
    ]);
    expect(browser.open).toHaveBeenCalledTimes(3);
    expect(fixture.tabs.map((tab) => tab.url)).toEqual([originalUrl]);
  });
});
