import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it, vi } from "vitest";
import { useBrowserDashboardTestHarness } from "../../browser-dashboard.test-harness.js";
import type { BrowserActRequest } from "../client-actions.types.js";
import type { BrowserTab } from "../client.types.js";
import { gotoPageWithNavigationGuard as gotoPageWithNavigationGuardReal } from "../pw-session-navigation.js";
import {
  getPwToolsCoreSessionMocks,
  installPwToolsCoreTestHooks,
  setPwToolsCoreCurrentPage,
  setPwToolsCoreCurrentRefLocator,
} from "../pw-tools-core.test-harness.js";
import type { BrowserRouteContext, ProfileContext } from "../server-context.js";
import { makeBrowserProfile, makeBrowserServerState } from "../server-context.test-harness.js";
import { createBrowserRouteApp, createBrowserRouteResponse } from "./test-helpers.js";

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
  assertBrowserDashboardTargetCurrent,
  reconcileBrowserDashboards,
  requestBrowserDashboard,
  stopBrowserDashboard,
} from "../../browser-dashboard.js";
import { registerBrowserAgentActRoutes } from "./agent.act.js";
import { registerBrowserAgentSnapshotRoutes } from "./agent.snapshot.js";

installPwToolsCoreTestHooks();
const sessionKey = "agent:main:dashboard-action-proof";
const request = { sessionKey, agentId: "main", name: "service" };

function dashboardRoute(tab: BrowserTab, route: "/act" | "/navigate" = "/act") {
  const profile = makeBrowserProfile();
  const unused = async (): Promise<never> => {
    throw new Error("Unexpected browser profile operation");
  };
  const profileCtx: ProfileContext = {
    profile,
    ensureBrowserAvailable: async () => {},
    ensureTabAvailable: async () => tab,
    isHttpReachable: async () => true,
    isTransportAvailable: async () => true,
    isReachable: async () => true,
    listTabs: async () => [tab],
    openTab: unused,
    labelTab: unused,
    focusTab: unused,
    closeTab: unused,
    stopRunningBrowser: unused,
    resetProfile: unused,
  };
  const state = makeBrowserServerState({
    profile,
    resolvedOverrides: { evaluateEnabled: true, ssrfPolicy: undefined },
  });
  const context: BrowserRouteContext = {
    ...profileCtx,
    state: () => state,
    forProfile: () => profileCtx,
    listProfiles: unused,
    mapTabError: () => null,
  };
  const { app, postHandlers } = createBrowserRouteApp();
  registerBrowserAgentActRoutes(app, context);
  registerBrowserAgentSnapshotRoutes(app, context);
  return postHandlers.get(route)!;
}

describe("dashboard action ownership", () => {
  const fixture = useBrowserDashboardTestHarness(browser, sessionKey);

  it.each([
    { revoke: "Stop", boundary: "batch" },
    { revoke: "Stop", boundary: "nested batch" },
    { revoke: "replacement", boundary: "batch" },
    { revoke: "replacement", boundary: "nested batch" },
    { revoke: "Stop", boundary: "submit" },
    { revoke: "replacement", boundary: "navigation preparation" },
  ])(
    "blocks the next effect after $revoke during $boundary with delayed tab close",
    async ({ revoke, boundary }) => {
      const dashboard = await requestBrowserDashboard(request);
      const targetId = dashboard.browserTab!.targetId;
      const tab: BrowserTab = { targetId, type: "page", title: "Service", url: dashboard.url };
      const waitEntered = createDeferred<void>();
      const releaseWait = createDeferred<void>();
      const closeEntered = createDeferred<void>();
      const releaseClose = createDeferred<{ status: "closed" }>();
      const nextEffect = vi.fn(async () => {});
      const holdAction = async () => {
        waitEntered.resolve();
        await releaseWait.promise;
      };
      const mainFrame = { url: () => tab.url };
      setPwToolsCoreCurrentPage({
        url: () => tab.url,
        mainFrame: () => mainFrame,
        isClosed: () => false,
        waitForTimeout: holdAction,
      });
      setPwToolsCoreCurrentRefLocator({
        click: nextEffect,
        fill: holdAction,
        press: nextEffect,
      });
      if (boundary === "navigation preparation") {
        getPwToolsCoreSessionMocks().withPageNavigationRequestGuard.mockImplementationOnce(
          async ({ action, page }) => {
            await holdAction();
            return await action(page.url());
          },
        );
      }
      browser.closeOwned.mockImplementation(async () => {
        closeEntered.resolve();
        return await releaseClose.promise;
      });
      const actions: BrowserActRequest[] = [
        { kind: "wait", timeMs: 1 },
        { kind: "click", ref: "1" },
      ];
      let body: BrowserActRequest = {
        kind: "batch",
        targetId,
        stopOnError: false,
        actions:
          boundary === "nested batch"
            ? [
                { kind: "batch", stopOnError: false, actions },
                { kind: "click", ref: "2" },
              ]
            : actions,
      };
      if (boundary === "submit") {
        body = { kind: "type", targetId, ref: "1", text: "updated value", submit: true };
      } else if (boundary === "navigation preparation") {
        body = { kind: "click", targetId, ref: "1" };
      }
      const response = createBrowserRouteResponse();
      const operation = Promise.resolve(
        dashboardRoute(tab)(
          {
            params: {},
            query: {},
            body,
            assertCurrent: async (profile) =>
              await assertBrowserDashboardTargetCurrent(dashboard, "main", {}, profile),
          },
          response.res,
        ),
      );
      let retirement: Promise<unknown> | undefined;
      try {
        await Promise.race([
          waitEntered.promise,
          operation.then(() => {
            throw new Error(
              `Action ended before wait: ${response.statusCode} ${JSON.stringify(response.body)}`,
            );
          }),
        ]);
        if (revoke === "replacement") {
          fixture.widgets[0]!.instanceId = "instance-two";
          retirement = reconcileBrowserDashboards();
        } else {
          retirement = stopBrowserDashboard(request);
        }
        await Promise.race([
          closeEntered.promise,
          retirement.then(() => {
            throw new Error("Dashboard retirement ended before closing its tab");
          }),
        ]);
        expect(fixture.tabs.map((entry) => entry.targetId)).toContain(targetId);
        releaseWait.resolve();
        await operation;
        expect(nextEffect).not.toHaveBeenCalled();
        expect(response.statusCode).toBeGreaterThanOrEqual(400);
        expect(response.body).toMatchObject({
          error: expect.stringMatching(/dashboard|Dashboard/),
        });
      } finally {
        releaseWait.resolve();
        releaseClose.resolve({ status: "closed" });
        await Promise.allSettled([operation, retirement]);
      }
    },
  );

  it.each([
    { revoke: "Stop", retry: false },
    { revoke: "replacement", retry: false },
    { revoke: "none", retry: false },
    { revoke: "Stop", retry: true },
    { revoke: "replacement", retry: true },
    { revoke: "none", retry: true },
  ])(
    "revalidates standalone navigation after $revoke during route preparation with retry=$retry",
    async ({ revoke, retry }) => {
      const dashboard = await requestBrowserDashboard(request);
      const targetId = dashboard.browserTab!.targetId;
      const tab: BrowserTab = { targetId, type: "page", title: "Service", url: dashboard.url };
      const preparationEntered = createDeferred<void>();
      const releasePreparation = createDeferred<void>();
      const closeEntered = createDeferred<void>();
      const releaseClose = createDeferred<{ status: "closed" }>();
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
        isClosed: () => false,
        goto,
        route: vi.fn(async () => {
          preparations += 1;
          if (preparations === (retry ? 2 : 1)) {
            preparationEntered.resolve();
            await releasePreparation.promise;
          }
        }),
        unroute: vi.fn(async () => {}),
      };
      setPwToolsCoreCurrentPage(page);
      const pwSession = await import("../pw-session.js");
      const gotoGuard = vi
        .mocked(pwSession.gotoPageWithNavigationGuard)
        .mockImplementation(gotoPageWithNavigationGuardReal);
      browser.closeOwned.mockImplementation(async () => {
        closeEntered.resolve();
        return await releaseClose.promise;
      });
      const response = createBrowserRouteResponse();
      const operation = Promise.resolve(
        dashboardRoute(tab, "/navigate")(
          {
            params: {},
            query: {},
            body: { targetId, url: requestedUrl },
            assertCurrent: async (profile) =>
              await assertBrowserDashboardTargetCurrent(dashboard, "main", {}, profile),
          },
          response.res,
        ),
      );
      let retirement: Promise<unknown> | undefined;
      try {
        await Promise.race([
          preparationEntered.promise,
          operation.then(() => {
            throw new Error(
              `Navigation ended before preparation: ${response.statusCode} ${JSON.stringify(response.body)}`,
            );
          }),
        ]);
        if (revoke !== "none") {
          if (revoke === "replacement") {
            fixture.widgets[0]!.instanceId = "instance-two";
            retirement = reconcileBrowserDashboards();
          } else {
            retirement = stopBrowserDashboard(request);
          }
          await Promise.race([
            closeEntered.promise,
            retirement.then(() => {
              throw new Error("Dashboard retirement ended before closing its tab");
            }),
          ]);
        }
        expect(fixture.tabs.map((entry) => entry.targetId)).toContain(targetId);
        releasePreparation.resolve();
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
        releasePreparation.resolve();
        releaseClose.resolve({ status: "closed" });
        await Promise.allSettled([operation, retirement]);
        gotoGuard.mockRestore();
      }
    },
  );
});
