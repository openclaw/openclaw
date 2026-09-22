import { setImmediate } from "node:timers/promises";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it, vi } from "vitest";
import { useBrowserDashboardTestHarness } from "./browser-dashboard.test-harness.js";

const browser = vi.hoisted(() => ({
  open: vi.fn(),
  tabs: vi.fn(),
  ownership: vi.fn(),
  closeOwned: vi.fn(),
}));
vi.mock("./browser/client.js", () => ({
  browserOpenTab: browser.open,
  browserTabs: browser.tabs,
}));
vi.mock("./browser/cdp.helpers.js", () => ({
  resolveCdpTabOwnership: browser.ownership,
  closeTrackedCdpTarget: browser.closeOwned,
}));

import { requestBrowserDashboard, stopBrowserDashboard } from "./browser-dashboard.js";
import { readBrowserDashboardTabs } from "./browser/session-tab-store.js";

const sessionKey = "agent:main:browser-dashboard-proof";
const request = { sessionKey, agentId: "main", name: "service" };

describe("Browser dashboard operation ordering", () => {
  const fixture = useBrowserDashboardTestHarness(browser, sessionKey);

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
      expect(readBrowserDashboardTabs().some((tab) => tab.dashboard?.state === "active")).toBe(
        false,
      );
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
          if (readBrowserDashboardTabs().some((tab) => tab.dashboard?.url === updatedUrl)) {
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
