import { describe, expect, it, vi } from "vitest";
import { useBrowserDashboardTestHarness } from "../../browser-dashboard.test-harness.js";
import type { BrowserActRequest } from "../client-actions.types.js";
import type { BrowserTab } from "../client.types.js";
import { gotoPageWithNavigationGuard as gotoPageWithNavigationGuardReal } from "../pw-session-navigation.js";
import {
  getPwToolsCoreSessionMocks as sessionMocks,
  installPwToolsCoreTestHooks,
  setPwToolsCoreCurrentPage,
  setPwToolsCoreCurrentRefLocator,
} from "../pw-tools-core.test-harness.js";
import { atBarrier, gate, startRoute } from "./agent-route.test-support.js";
import { createDashboardRouteContext } from "./dashboard-ownership.test-support.js";
import { createBrowserRouteApp } from "./test-helpers.js";

const browser = vi.hoisted(() => ({
  open: vi.fn(),
  tabs: vi.fn(),
  ownership: vi.fn(),
  closeOwned: vi.fn(),
}));
vi.mock("../client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../client.js")>()),
  browserOpenTab: browser.open,
  browserTabs: browser.tabs,
}));
vi.mock("../cdp.helpers.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../cdp.helpers.js")>()),
  resolveCdpTabOwnership: browser.ownership,
  closeTrackedCdpTarget: browser.closeOwned,
}));
vi.mock("../pw-ai-module.js", () => ({
  getPwAiModule: async () => ({
    ...(await import("../pw-tools-core.interactions.execution.js")),
    ...(await import("../pw-tools-core.snapshot.js")),
  }),
}));

import {
  assertBrowserDashboardTargetCurrent as assertCurrent,
  reconcileBrowserDashboards,
  requestBrowserDashboard,
  stopBrowserDashboard,
} from "../../browser-dashboard.js";
import { registerBrowserAgentActRoutes } from "./agent.act.js";
import { registerBrowserAgentSnapshotRoutes } from "./agent.snapshot.js";

installPwToolsCoreTestHooks();
const sessionKey = "agent:main:dashboard-action-proof";
const request = { sessionKey, agentId: "main", name: "service" };

function batch(actions: BrowserActRequest[]): BrowserActRequest {
  return { kind: "batch", stopOnError: false, actions };
}

function dashboardRoute(tab: BrowserTab, route: "/act" | "/navigate" = "/act") {
  const context = createDashboardRouteContext(tab, { evaluateEnabled: true });
  const { app, postHandlers } = createBrowserRouteApp();
  registerBrowserAgentActRoutes(app, context);
  registerBrowserAgentSnapshotRoutes(app, context);
  return postHandlers.get(route)!;
}

describe("dashboard action ownership", () => {
  const fixture = useBrowserDashboardTestHarness(browser, sessionKey);
  function retire(kind: string) {
    if (kind === "replacement") {
      fixture.widgets[0]!.instanceId = "instance-two";
      return reconcileBrowserDashboards();
    }
    return stopBrowserDashboard(request);
  }

  it.each([
    { revoke: "replacement", boundary: "nested batch" },
    { revoke: "Stop", boundary: "submit" },
    { revoke: "replacement", boundary: "navigation preparation" },
  ])("blocks $boundary after $revoke before tab close", async ({ revoke, boundary }) => {
    const dashboard = await requestBrowserDashboard(request);
    const targetId = dashboard.browserTab!.targetId;
    const tab: BrowserTab = { targetId, type: "page", title: "Service", url: dashboard.url };
    const ready = gate();
    const closing = gate<{ status: "closed" }>();
    const nextEffect = vi.fn(async () => {});
    const mainFrame = { url: () => tab.url };
    setPwToolsCoreCurrentPage({
      url: () => tab.url,
      mainFrame: () => mainFrame,
      waitForTimeout: ready.block,
    });
    setPwToolsCoreCurrentRefLocator({ click: nextEffect, fill: ready.block, press: nextEffect });
    if (boundary === "navigation preparation") {
      sessionMocks().withPageNavigationRequestGuard.mockImplementationOnce(
        async ({ action, page }) => {
          await ready.block();
          return await action(page.url());
        },
      );
    }
    browser.closeOwned.mockImplementation(closing.block);
    const body: BrowserActRequest =
      boundary === "submit"
        ? { kind: "type", targetId, ref: "1", text: "updated value", submit: true }
        : boundary === "navigation preparation"
          ? { kind: "click", targetId, ref: "1" }
          : {
              ...batch([
                batch([
                  { kind: "wait", timeMs: 1 },
                  { kind: "click", ref: "1" },
                ]),
                { kind: "click", ref: "2" },
              ]),
              targetId,
            };
    const { response, completion: operation } = startRoute(dashboardRoute(tab), {
      body,
      assertCurrent: (profile) => assertCurrent(dashboard, "main", {}, profile),
    });
    let retirement: Promise<unknown> | undefined;
    try {
      await atBarrier(ready.entered, operation, "Action ended before wait", response);
      retirement = retire(revoke);
      await atBarrier(closing.entered, retirement, "retired before tab close");
      expect(fixture.tabs.map((entry) => entry.targetId)).toContain(targetId);
      ready.resolve();
      await operation;
      expect(nextEffect).not.toHaveBeenCalled();
      expect(response.statusCode).toBeGreaterThanOrEqual(400);
      expect(response.body).toMatchObject({
        error: expect.stringMatching(/dashboard|Dashboard/),
      });
    } finally {
      ready.resolve();
      closing.resolve({ status: "closed" });
      await Promise.allSettled([operation, retirement]);
    }
  });

  it.each([
    { revoke: "Stop", retry: false },
    { revoke: "none", retry: false },
    { revoke: "replacement", retry: true },
    { revoke: "none", retry: true },
  ])("revalidates navigation after $revoke (retry=$retry)", async ({ revoke, retry }) => {
    const dashboard = await requestBrowserDashboard(request);
    const targetId = dashboard.browserTab!.targetId;
    const tab: BrowserTab = { targetId, type: "page", title: "Service", url: dashboard.url };
    const ready = gate();
    const closing = gate<{ status: "closed" }>();
    const requestedUrl = "https://93.184.216.34/next";
    let currentUrl = dashboard.url;
    let navigations = 0;
    let preparations = 0;
    const goto = vi.fn(async (url: string) => {
      navigations += 1;
      if (retry && navigations === 1) {
        throw new Error("page.goto: Frame has been detached");
      }
      currentUrl = url;
      return null;
    });
    const page = {
      url: () => currentUrl,
      goto,
      route: vi.fn(async () => {
        preparations += 1;
        if (preparations === (retry ? 2 : 1)) {
          await ready.block();
        }
      }),
      unroute: vi.fn(async () => {}),
    };
    setPwToolsCoreCurrentPage(page);
    const pwSession = await import("../pw-session.js");
    const gotoGuard = vi
      .mocked(pwSession.gotoPageWithNavigationGuard)
      .mockImplementation(gotoPageWithNavigationGuardReal);
    browser.closeOwned.mockImplementation(closing.block);
    const { response, completion: operation } = startRoute(dashboardRoute(tab, "/navigate"), {
      body: { targetId, url: requestedUrl },
      assertCurrent: (profile) => assertCurrent(dashboard, "main", {}, profile),
    });
    let retirement: Promise<unknown> | undefined;
    try {
      await atBarrier(ready.entered, operation, "Navigation ended before ready", response);
      if (revoke !== "none") {
        retirement = retire(revoke);
        await atBarrier(closing.entered, retirement, "retired before tab close");
      }
      expect(fixture.tabs.map((entry) => entry.targetId)).toContain(targetId);
      ready.resolve();
      await operation;
      if (revoke === "none") {
        expect(goto).toHaveBeenCalledTimes(retry ? 2 : 1);
        expect(response.statusCode).toBe(200);
        expect(response.body).toMatchObject({ ok: true, targetId, url: requestedUrl });
        expect(page.url()).toBe(requestedUrl);
      } else {
        expect(goto).toHaveBeenCalledTimes(retry ? 1 : 0);
        expect(response.statusCode).toBeGreaterThanOrEqual(400);
        expect(response.body).toMatchObject({ error: expect.stringMatching(/dashboard/i) });
        expect(page.url()).toBe(dashboard.url);
      }
      expect(page.unroute).toHaveBeenCalledTimes(retry ? 2 : 1);
    } finally {
      ready.resolve();
      closing.resolve({ status: "closed" });
      await Promise.allSettled([operation, retirement]);
      gotoGuard.mockRestore();
    }
  });
});
