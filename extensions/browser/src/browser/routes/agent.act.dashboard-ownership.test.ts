import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useBrowserDashboardTestHarness } from "../../browser-dashboard.test-harness.js";
import type { BrowserActRequest } from "../client-actions.types.js";
import type { BrowserTab } from "../client.types.js";
import { gotoPageWithNavigationGuard as gotoPageWithNavigationGuardReal } from "../pw-session-navigation.js";
import {
  getPwToolsCoreSessionMocks as sessionMocks,
  installPwToolsCoreTestHooks,
  setPwToolsCoreCurrentPage,
  setPwToolsCoreCurrentRefLocator,
  setPwToolsCoreDownloadCapture,
} from "../pw-tools-core.test-harness.js";
import { createProfileSelectionOps } from "../server-context.selection.js";
import { atBarrier, gate as createGate, startRoute } from "./agent-route.test-support.js";
import { createDashboardRouteContext } from "./dashboard-ownership.test-support.js";
import { createBrowserRouteApp } from "./test-helpers.js";

const browser = vi.hoisted(() => ({
  open: vi.fn(),
  tabs: vi.fn(),
  ownership: vi.fn(),
  closeOwned: vi.fn(),
  fetchOk: vi.fn(),
  withCdpSocket: vi.fn(),
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
  fetchOk: browser.fetchOk,
  withCdpSocket: browser.withCdpSocket,
}));
const transferPreparation = vi.hoisted(() => ({
  paths: vi.fn(),
  module: vi.fn(),
  output: vi.fn(),
}));
const suite = vi.hoisted(() => ({ mode: "actions" }));
vi.mock("../paths.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../paths.js")>()),
  resolveExistingUploadPaths: async ({ requestedPaths }: { requestedPaths: string[] }) => {
    await transferPreparation.paths();
    return { ok: true, paths: requestedPaths };
  },
  resolveStrictExistingUploadPaths: async ({ requestedPaths }: { requestedPaths: string[] }) => ({
    ok: true,
    paths: requestedPaths,
  }),
}));
// mock-isolation: Hold output preparation without creating real download directories.
vi.mock("../output-directories.js", () => ({
  ensureOutputDirectory: async () => await transferPreparation.output(),
}));
// mock-isolation: Use synthetic output paths while testing dashboard authority, not filesystem policy.
vi.mock("./output-paths.js", () => ({
  resolveWritableOutputPathOrRespond: async ({ requestedPath }: { requestedPath: string }) =>
    requestedPath,
}));

vi.mock("../chrome.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../chrome.js")>()),
  getChromeWebSocketEndpoint: async () => ({ url: "ws://127.0.0.1:18800/devtools/browser/test" }),
}));
vi.mock("../pw-session-connection.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../pw-session-connection.js")>()),
  getPageForTargetId: () => sessionMocks().getPageForTargetId(),
}));

// mock-isolation: Select synthetic action modules without loading a live browser connection.
vi.mock("../pw-ai-module.js", () => ({
  getPwAiModule: async () => {
    if (suite.mode === "transfers") {
      await transferPreparation.module();
      return {
        ...(await import("../pw-tools-core.interactions.content.js")),
        ...(await import("../pw-tools-core.downloads.js")),
      };
    }
    if (suite.mode === "state") {
      return {
        ...(await import("../pw-tools-core.state.js")),
        ...(await import("../pw-tools-core.storage.js")),
        ...(await import("../pw-session-actions.js")),
        getPageForTargetId: sessionMocks().getPageForTargetId,
      };
    }
    return {
      ...(await import("../pw-tools-core.interactions.execution.js")),
      ...(await import("../pw-tools-core.snapshot.js")),
    };
  },
}));

import {
  assertBrowserDashboardTargetCurrent,
  reconcileBrowserDashboards,
  requestBrowserDashboard,
  stopBrowserDashboard,
} from "../../browser-dashboard.js";
import { registerBrowserAgentActDownloadRoutes } from "./agent.act.download.js";
import { registerBrowserAgentActHookRoutes } from "./agent.act.hooks.js";
import { registerBrowserAgentActRoutes } from "./agent.act.js";
import { registerBrowserAgentSnapshotRoutes } from "./agent.snapshot.js";
import { registerBrowserAgentStorageRoutes } from "./agent.storage.js";
import { registerBrowserPermissionRoutes } from "./permissions.js";
import { registerBrowserTabRoutes } from "./tabs.js";

installPwToolsCoreTestHooks();
const sessionKey = "agent:main:dashboard-action-proof";
const request = { sessionKey, agentId: "main", name: "service" };
const fixture = useBrowserDashboardTestHarness(browser, sessionKey);

async function dashboardTarget() {
  const dashboard = await requestBrowserDashboard(request);
  const targetId = dashboard.browserTab!.targetId;
  const tab: BrowserTab = { targetId, type: "page", title: "Service", url: dashboard.url };
  return {
    dashboard,
    targetId,
    tab,
    assertCurrent: (profile?: Parameters<typeof assertBrowserDashboardTargetCurrent>[3]) =>
      assertBrowserDashboardTargetCurrent(dashboard, "main", {}, profile),
  };
}

function heldOperation(targetId: string) {
  const ready = createGate();
  const closing = createGate<{ status: "closed" }>();
  return {
    ready,
    closing,
    complete: async (
      { response, completion }: ReturnType<typeof startRoute>,
      revoke: string,
      verify: () => void | Promise<void>,
    ) => {
      let retirement: Promise<unknown> | undefined;
      try {
        await atBarrier(ready.entered, completion, "Operation ended before preparation", response);
        if (revoke !== "none") {
          if (revoke === "replacement") {
            fixture.widgets[0]!.instanceId = "instance-two";
          }
          retirement =
            revoke === "replacement" ? reconcileBrowserDashboards() : stopBrowserDashboard(request);
          await atBarrier(closing.entered, retirement, "retired before tab close");
        }
        expect(fixture.tabs.map((entry) => entry.targetId)).toContain(targetId);
        ready.resolve();
        await completion;
        await verify();
      } finally {
        ready.resolve();
        closing.resolve({ status: "closed" });
        await Promise.allSettled([completion, retirement]);
      }
    },
  };
}

function batch(actions: BrowserActRequest[]): BrowserActRequest {
  return { kind: "batch", stopOnError: false, actions };
}

function expectRevoked(
  response: ReturnType<typeof startRoute>["response"],
  pattern = /dashboard/i,
) {
  expect(response.statusCode).toBeGreaterThanOrEqual(400);
  expect(response.body).toMatchObject({ error: expect.stringMatching(pattern) });
}

function dashboardRoute(
  tab: BrowserTab,
  route: "/act" | "/navigate" = "/act",
  beforeResolve?: () => Promise<void>,
) {
  const context = createDashboardRouteContext(tab, { evaluateEnabled: true });
  if (beforeResolve) {
    context.forProfile().ensureTabAvailable = async () => {
      await beforeResolve();
      return tab;
    };
  }
  const { app, postHandlers } = createBrowserRouteApp();
  registerBrowserAgentActRoutes(app, context);
  registerBrowserAgentSnapshotRoutes(app, context);
  return postHandlers.get(route)!;
}

describe("dashboard action ownership", () => {
  beforeEach(() => {
    suite.mode = "actions";
  });
  it.each([
    { revoke: "replacement", boundary: "nested batch" },
    { revoke: "Stop", boundary: "submit" },
    { revoke: "replacement", boundary: "navigation preparation" },
    { revoke: "replacement", boundary: "target resolution" },
  ])("blocks $boundary after $revoke before tab close", async ({ revoke, boundary }) => {
    const { targetId, tab, assertCurrent } = await dashboardTarget();
    const { ready, closing, complete } = heldOperation(targetId);
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
    const running = startRoute(
      dashboardRoute(tab, "/act", boundary === "target resolution" ? ready.block : undefined),
      {
        body,
        assertCurrent,
      },
    );
    const { response } = running;
    await complete(running, revoke, async () => {
      expect(nextEffect).not.toHaveBeenCalled();
      expectRevoked(response, /dashboard|Dashboard/);
    });
  });

  it.each([
    { revoke: "Stop", retry: false },
    { revoke: "none", retry: false },
    { revoke: "replacement", retry: true },
    { revoke: "none", retry: true },
  ])("revalidates navigation after $revoke (retry=$retry)", async ({ revoke, retry }) => {
    const { dashboard, targetId, tab, assertCurrent } = await dashboardTarget();
    const { ready, closing, complete } = heldOperation(targetId);
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
    const sessions: Array<EventEmitter & { detach: ReturnType<typeof vi.fn> }> = [];
    const page = {
      url: () => currentUrl,
      goto,
      context: () => ({
        newCDPSession: async () => {
          const session = Object.assign(new EventEmitter(), {
            send: vi.fn(async (method: string) => {
              if (method === "Page.getFrameTree") {
                return { frameTree: { frame: { id: "main" } } };
              }
              if (method === "Target.getTargetInfo") {
                return { targetInfo: { targetId, title: tab.title } };
              }
              // Hold the actual document-fence preparation, including on a retried navigation.
              if (method === "Fetch.enable") {
                preparations += 1;
                if (preparations === (retry ? 2 : 1)) {
                  await ready.block();
                }
              }
              return {};
            }),
            detach: vi.fn(async () => {}),
          });
          sessions.push(session);
          return session;
        },
      }),
    };
    setPwToolsCoreCurrentPage(page);
    const pwSession = await import("../pw-session.js");
    const gotoGuard = vi
      .mocked(pwSession.gotoPageWithNavigationGuard)
      .mockImplementation(gotoPageWithNavigationGuardReal);
    browser.closeOwned.mockImplementation(closing.block);
    const running = startRoute(dashboardRoute(tab, "/navigate"), {
      body: { targetId, url: requestedUrl },
      assertCurrent,
    });
    const { response } = running;
    await complete(running, revoke, async () => {
      if (revoke === "none") {
        expect(goto).toHaveBeenCalledTimes(retry ? 2 : 1);
        expect(response.statusCode).toBe(200);
        expect(response.body).toMatchObject({ ok: true, targetId, url: requestedUrl });
        expect(page.url()).toBe(requestedUrl);
      } else {
        expect(goto).toHaveBeenCalledTimes(retry ? 1 : 0);
        expectRevoked(response);
        expect(page.url()).toBe(dashboard.url);
      }
      expect(preparations).toBe(retry ? 2 : 1);
      // Successful navigation also reads the selected target through a temporary CDP session.
      expect(sessions).toHaveLength((retry ? 2 : 1) + (revoke === "none" ? 1 : 0));
      for (const session of sessions) {
        expect(session.detach).toHaveBeenCalledOnce();
        expect(session.eventNames()).toEqual([]);
      }
    }).finally(() => gotoGuard.mockRestore());
  });
});

function transferRoutes(tab: BrowserTab) {
  const context = createDashboardRouteContext(tab);
  const { app, postHandlers } = createBrowserRouteApp();
  registerBrowserAgentActHookRoutes(app, context);
  registerBrowserAgentActDownloadRoutes(app, context);
  return postHandlers;
}

const transferCases = [
  ["input", "/hooks/file-chooser", { inputRef: "1", paths: ["/tmp/upload.txt"] }, "paths"],
  ["upload", "/hooks/file-chooser", { ref: "1", paths: ["/tmp/upload.txt"] }, "paths"],
  ["upload arm", "/hooks/file-chooser", { paths: ["/tmp/upload.txt"] }, "paths"],
  ["dialog arm", "/hooks/dialog", { accept: true }, "module"],
  ["download", "/download", { ref: "1", path: "/tmp/download.txt" }, "output"],
  ["download waiter", "/wait/download", { path: "/tmp/download.txt" }, "output"],
] as const;

describe("dashboard transfer authority", () => {
  beforeEach(() => {
    suite.mode = "transfers";
  });
  it.each(
    transferCases.flatMap(([kind, path, body, gate]) =>
      (kind === "upload" ? ["Stop", "absent"] : ["Stop", "current"]).map((authority) => ({
        kind,
        path,
        body,
        gate,
        authority,
      })),
    ),
  )(
    "checks $kind authority after $authority during preparation",
    async ({ kind, path, body, gate, authority }) => {
      for (const prepare of Object.values(transferPreparation)) {
        prepare.mockResolvedValue(undefined);
      }
      const { targetId, tab, assertCurrent } = await dashboardTarget();
      const { ready, closing, complete } = heldOperation(targetId);
      transferPreparation[gate].mockImplementationOnce(ready.block);
      const nativeEffect = vi.fn(async () => {});
      const waitForEvent = vi.fn(async () => ({ setFiles: nativeEffect }));
      setPwToolsCoreCurrentPage({ url: () => tab.url, isClosed: () => false, waitForEvent });
      setPwToolsCoreCurrentRefLocator({ setInputFiles: nativeEffect, click: nativeEffect });
      sessionMocks().armObservedDialogResponseOnPage.mockImplementation(() => {
        void nativeEffect();
      });
      setPwToolsCoreDownloadCapture({
        armed: true,
        promise: Promise.resolve({
          url: tab.url,
          path: "/tmp/download.txt",
          suggestedFilename: "download.txt",
        }),
        cancel: vi.fn(),
      });
      browser.closeOwned.mockImplementation(async () => {
        closing.enter();
        await closing.promise;
        fixture.tabs = fixture.tabs.filter((entry) => entry.targetId !== targetId);
        return { status: "closed" };
      });
      const running = startRoute(transferRoutes(tab).get(path), {
        body: { ...body, targetId },
        ...(authority === "absent" ? {} : { assertCurrent }),
      });
      const { response } = running;
      await complete(running, authority === "Stop" ? "Stop" : "none", async () => {
        if (authority === "Stop") {
          expect(nativeEffect).not.toHaveBeenCalled();
          expect(waitForEvent).not.toHaveBeenCalled();
          expectRevoked(response);
        } else {
          expect(response.statusCode).toBe(200);
          if (kind !== "download waiter") {
            await vi.waitFor(() => expect(nativeEffect).toHaveBeenCalled());
          }
          expect(response.body).toMatchObject({ ok: true });
        }
      });
    },
  );
});

type Preparation = "cdp" | "device queue" | "focus" | "permission socket";
const origin = "http://service.example";
const cookie = { name: "theme", value: "dark", url: `${origin}/` };
const mutations: Array<[string, Record<string, unknown>?, Preparation?, number?]> = [
  ["/set/media", { colorScheme: "dark" }],
  ["/set/locale", { locale: "en-US" }, "cdp"],
  ["/set/timezone", { timezoneId: "UTC" }, "cdp"],
  ["/set/device", { name: "Desktop Chrome" }, "device queue", 4],
  ["/set/offline", { offline: true }],
  ["/set/headers", { headers: { "X-Test": "fixture" } }],
  ["/set/credentials", { username: "fixture", password: "not-real" }],
  ["/set/geolocation", { latitude: 0, longitude: 0 }, undefined, 2],
  ["/cookies/set", { cookie }],
  ["/cookies/set-many", { cookies: [cookie] }],
  ["/cookies/clear"],
  ["/storage/:kind/set", { key: " theme ", value: " dark " }],
  ["/storage/:kind/clear"],
  ["/permissions/grant", { origin, permissions: ["audioCapture"] }],
  ["/permissions/grant", { origin, permissions: ["clipboardReadWrite"] }, "permission socket"],
  ["/tabs/focus", {}, "focus"],
];

function stateRoute(tab: BrowserTab, route: string, beforeFocus?: () => Promise<void>) {
  const listTabs = async () => {
    await beforeFocus?.();
    return [tab];
  };
  const context = createDashboardRouteContext(tab, {
    selection: (profile) => ({
      listTabs,
      focusTab: createProfileSelectionOps({
        profile,
        runtime: { profile, running: null },
        getCdpControlPolicy: () => undefined,
        listTabs,
        openTab: async () => {
          throw new Error("Unexpected profile operation");
        },
      }).focusTab,
    }),
  });
  const { app, postHandlers } = createBrowserRouteApp();
  registerBrowserAgentStorageRoutes(app, context);
  registerBrowserPermissionRoutes(app, context);
  registerBrowserTabRoutes(app, context);
  return postHandlers.get(route)!;
}

describe("dashboard state authority", () => {
  beforeEach(() => {
    suite.mode = "state";
  });
  it.each(
    mutations.flatMap(([route, body = {}, preparation, effects]) =>
      [false, true].map((stop) => ({ route, body, preparation, effects, stop })),
    ),
  )("$route/$preparation revalidates with stop=$stop", async (spec) => {
    const { dashboard, targetId, tab, assertCurrent } = await dashboardTarget();
    const { ready, closing, complete } = heldOperation(targetId);
    const effect = vi.fn(async () => {});
    const page = {
      url: () => dashboard.url,
      context: () => ({
        addCookies: effect,
        clearCookies: effect,
        setOffline: effect,
        setExtraHTTPHeaders: effect,
        setHTTPCredentials: effect,
        setGeolocation: effect,
        grantPermissions: effect,
        newCDPSession: async () => {
          if (spec.preparation === "cdp") {
            await ready.block();
          }
          return { send: effect };
        },
      }),
      evaluate: effect,
      emulateMedia: effect,
      setViewportSize: effect,
      bringToFront: effect,
    };
    setPwToolsCoreCurrentPage(page);
    if (!spec.preparation) {
      sessionMocks().getPageForTargetId.mockImplementationOnce(() =>
        ready.block().then(() => page),
      );
    } else if (spec.preparation === "device queue") {
      const state = sessionMocks().ensurePageState();
      let tail: Promise<void> | undefined = ready.promise;
      Object.assign(state, {
        emulation: {
          get transitionTail() {
            ready.enter();
            return tail;
          },
          set transitionTail(value: Promise<void> | undefined) {
            tail = value;
          },
        },
      });
    }
    browser.fetchOk.mockImplementation(effect);
    browser.withCdpSocket.mockImplementation(async (_url, run) => {
      if (spec.preparation === "permission socket") {
        await ready.block();
      }
      return await run(effect);
    });
    browser.closeOwned.mockImplementation(closing.block);
    const beforeFocus = spec.preparation === "focus" ? ready.block : undefined;
    const running = startRoute(stateRoute(tab, spec.route, beforeFocus), {
      params: { kind: spec.route === "/storage/:kind/set" ? " session " : " local " },
      body: { ...spec.body, targetId },
      assertCurrent,
    });
    const { response } = running;
    await complete(running, spec.stop ? "Stop" : "none", async () => {
      expect(effect).toHaveBeenCalledTimes(spec.stop ? 0 : (spec.effects ?? 1));
      if (spec.stop) {
        expectRevoked(response);
      } else {
        expect(response).toMatchObject({ statusCode: 200, body: { ok: true } });
        if (spec.route === "/storage/:kind/set") {
          expect(effect).toHaveBeenCalledWith(expect.any(Function), {
            kind: "session",
            key: " theme ",
            value: " dark ",
          });
        }
      }
    });
  });
});
