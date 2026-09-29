import { setImmediate } from "node:timers/promises";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it, vi } from "vitest";
import {
  interceptStoreActions,
  useBrowserDashboardTestHarness,
} from "./browser-dashboard.test-harness.js";
import { getBrowserStateRuntime } from "./browser-runtime-state.js";
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
      const readCompleted = createDeferred<void>();
      const releaseRead = createDeferred<void>();
      const mutationPrepared = createDeferred<void>();
      const releaseMutation = createDeferred<void>();
      const closeRequested = createDeferred<void>();
      const preparingRegistration = createDeferred<void>();
      const finishPreparation = createDeferred<void>();
      const targetOpened = createDeferred<void>();
      const finishOpen = createDeferred<void>();
      const dispatched = createDeferred<void>();
      const finishClose = createDeferred<void>();
      const runtime = getBrowserStateRuntime();
      const bind = runtime.sessionTabs.withCurrent;
      if (!bind) {
        throw new Error("Expected the real worker comparison store");
      }
      let remainingReads = identity === "known" ? 1 : 2;
      let closeStarted = false;
      let holdMutation = order === "registration-first";
      const observer = vi
        .spyOn(runtime.sessionTabs, "withCurrent")
        .mockImplementation((authority) => {
          const store = bind(authority);
          return {
            ...store,
            entries: async () => {
              const entries = await store.entries();
              if (order === "close-first" && closeStarted && --remainingReads === 0) {
                readCompleted.resolve();
                await releaseRead.promise;
              }
              return entries;
            },
            observe: async (key) => {
              const result = await store.observe(key);
              mutationPrepared.resolve();
              if (holdMutation) {
                holdMutation = false;
                await releaseMutation.promise;
              }
              return result;
            },
          };
        });
      const close = vi.fn(async () => {
        dispatched.resolve();
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
              preparingRegistration.resolve();
              await finishPreparation.promise;
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
      let opening: ReturnType<typeof requestBrowserDashboard> | undefined;
      let opened = false;
      try {
        opening = requestBrowserDashboard(request).then((result) => {
          opened = true;
          return result;
        });
        if (order === "close-first") {
          await targetOpened.promise;
          expect(fixture.tabs.map((tab) => tab.targetId)).toEqual(["target-1"]);
          closeStarted = true;
          closing = closePage();
          await readCompleted.promise;
          finishOpen.resolve();
        }
        if (order === "preparation-first") {
          await preparingRegistration.promise;
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
          releaseRead.resolve();
          await dispatched.promise;
          await expect(opening).rejects.toThrow("close was dispatched during registration");
          expect(opened).toBe(false);
          expect(close).toHaveBeenCalledOnce();
          finishClose.resolve();
          await closing;
          expect(fixture.tabs).toEqual([]);
          expect(await readBrowserDashboardTabs()).toEqual([]);
        } else {
          expect(close).not.toHaveBeenCalled();
          finishPreparation.resolve();
          releaseMutation.resolve();
          await opening;
          finishClose.resolve();
          await expect(closing).rejects.toThrow(/dashboard|retained/);
          expect(close).not.toHaveBeenCalled();
          expect(opened).toBe(true);
          expect(fixture.tabs.map((tab) => tab.targetId)).toEqual(["target-1"]);
          expect((await readBrowserDashboardTabs())[0]?.nativeTargetId).toBe("target-1");
        }
      } finally {
        releaseRead.resolve();
        finishPreparation.resolve();
        finishOpen.resolve();
        releaseMutation.resolve();
        finishClose.resolve();
        await Promise.allSettled([...(closing ? [closing] : []), ...(opening ? [opening] : [])]);
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

  it.each([
    "initiator cancelled",
    "follower cancelled",
    "backend failed",
    "definition updated",
    "layout updated",
    "stop after cancellation",
    "stop after resume",
    "stop after normal open",
    "stop after follower cancellation",
    "stop after cold cancellation",
  ] as const)("keeps shared materialization failures scoped when %s", async (failure) => {
    const started = createDeferred<void>();
    const finish = createDeferred<void>();
    const followerRead = createDeferred<void>();
    const backendError = new Error("Chrome startup failed");
    const stopping = failure.startsWith("stop ");
    const cancelInitiator =
      failure === "initiator cancelled" ||
      ["stop after cancellation", "stop after resume", "stop after cold cancellation"].includes(
        failure,
      );
    const cancelFollower =
      failure === "follower cancelled" || failure === "stop after follower cancellation";
    browser.open.mockImplementation(async () => {
      await setImmediate();
      return fixture.openedTab();
    });
    browser.open.mockImplementationOnce(async () => {
      started.resolve();
      await finish.promise;
      if (failure === "backend failed" || failure === "layout updated") {
        throw backendError;
      }
      if (failure === "stop after cold cancellation") {
        throw initiator.signal.reason;
      }
      return fixture.openedTab();
    });
    const initiator = new AbortController();
    const follower = new AbortController();
    const opening = requestBrowserDashboard(request, { signal: initiator.signal });
    await started.promise;
    if (failure === "definition updated") {
      fixture.widgets[0]!.props.url = "http://updated.example/";
      fixture.widgets[0]!.revision += 1;
    } else if (failure === "layout updated") {
      fixture.widgets[0]!.revision += 1;
    }
    fixture.readBoard.mockImplementationOnce(async () => {
      followerRead.resolve();
      return structuredClone({ sessionKey, widgets: fixture.widgets });
    });
    const waiting = requestBrowserDashboard(
      { ...request, resume: failure === "stop after resume" },
      { signal: follower.signal },
    );
    const settled = Promise.allSettled([opening, waiting]);
    await followerRead.promise;
    await setImmediate();
    const stopCall = stopping ? stopBrowserDashboard(request) : undefined;
    if (cancelInitiator) {
      initiator.abort(new Error("initiator cancelled"));
    } else if (cancelFollower) {
      follower.abort(new Error("follower cancelled"));
    }
    finish.resolve();
    const results = await settled;
    if (stopCall) {
      expect((await stopCall).paused).toBe(true);
      expect(results[0].status).toBe(cancelInitiator ? "rejected" : "fulfilled");
      expect(results[1].status).toBe(cancelFollower ? "rejected" : "fulfilled");
      expect(fixture.tabs).toEqual([]);
      expect(
        (await readBrowserDashboardTabs()).some((tab) => tab.dashboard?.state === "active"),
      ).toBe(false);
      expect((await requestBrowserDashboard({ ...request, resume: true })).paused).toBe(false);
      expect(fixture.tabs).toHaveLength(1);
      return;
    }
    if (failure === "initiator cancelled" || failure === "definition updated") {
      expect(results[0]).toMatchObject({
        status: "rejected",
        reason: {
          message:
            failure === "initiator cancelled"
              ? "initiator cancelled"
              : expect.stringContaining("changed during this operation"),
        },
      });
      expect(results[1]).toMatchObject({
        status: "fulfilled",
        value: { browserTab: { targetId: "target-2" } },
      });
      expect(browser.open).toHaveBeenCalledTimes(2);
      expect(fixture.tabs.map((tab) => tab.targetId)).toEqual(["target-2"]);
      if (failure === "definition updated") {
        expect(results[1]).toMatchObject({
          value: { url: "http://updated.example/", revision: 2 },
        });
        expect(browser.open).toHaveBeenLastCalledWith(
          undefined,
          "http://updated.example/",
          expect.objectContaining({ profile: "openclaw" }),
        );
      }
    } else if (failure === "follower cancelled") {
      expect(results[0]).toMatchObject({
        status: "fulfilled",
        value: { browserTab: { targetId: "target-1" } },
      });
      expect(results[1]).toMatchObject({
        status: "rejected",
        reason: { message: "follower cancelled" },
      });
      expect(browser.open).toHaveBeenCalledOnce();
      expect(fixture.tabs.map((tab) => tab.targetId)).toEqual(["target-1"]);
    } else {
      expect(results).toEqual([
        { status: "rejected", reason: backendError },
        { status: "rejected", reason: backendError },
      ]);
      expect(browser.open).toHaveBeenCalledOnce();
      expect(fixture.tabs).toEqual([]);
    }
  });

  it.each(["cancelled intermediate", "successful successor"] as const)(
    "preserves failure ownership through a %s",
    async (condition) => {
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
      const middle = new AbortController();
      const originalUrl = fixture.widgets[0]!.props.url;
      const updatedUrl = "http://updated.example/";
      if (condition === "successful successor") {
        fixture.widgets[0]!.props.url = updatedUrl;
      }
      const waiting = requestBrowserDashboard(request, { signal: middle.signal });
      const following = requestBrowserDashboard(request);
      const settled = Promise.allSettled([opening, waiting, following]);
      await setImmediate();
      if (condition === "cancelled intermediate") {
        middle.abort(new Error("queued caller cancelled"));
      } else {
        fixture.readBoard.mockImplementation(async () => {
          if ((await readBrowserDashboardTabs()).some((tab) => tab.dashboard?.url === updatedUrl)) {
            fixture.widgets[0]!.props.url = originalUrl;
          }
          return structuredClone({ sessionKey, widgets: fixture.widgets });
        });
      }
      finish.resolve();
      const results = await settled;
      expect(results[0]).toEqual({ status: "rejected", reason: backendError });
      if (condition === "cancelled intermediate") {
        expect(results.slice(1)).toEqual([
          { status: "rejected", reason: middle.signal.reason },
          { status: "rejected", reason: backendError },
        ]);
        expect(browser.open).toHaveBeenCalledOnce();
        expect(fixture.tabs).toEqual([]);
      } else {
        expect(results.slice(1)).toMatchObject([
          { status: "fulfilled", value: { url: updatedUrl } },
          { status: "fulfilled", value: { url: originalUrl } },
        ]);
        expect(browser.open).toHaveBeenCalledTimes(3);
        expect(fixture.tabs.map((tab) => tab.url)).toEqual([originalUrl]);
      }
    },
  );
});
