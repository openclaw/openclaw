import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it, vi } from "vitest";
import { useBrowserDashboardTestHarness } from "../../browser-dashboard.test-harness.js";
import type { BrowserTab } from "../client.types.js";
import {
  getPwToolsCoreSessionMocks,
  installPwToolsCoreTestHooks,
  setPwToolsCoreCurrentPage,
} from "../pw-tools-core.test-harness.js";
import type { BrowserRouteContext, ProfileContext } from "../server-context.js";
import { createProfileSelectionOps } from "../server-context.selection.js";
import { makeBrowserProfile, makeBrowserServerState } from "../server-context.test-harness.js";
import { createBrowserRouteApp, createBrowserRouteResponse } from "./test-helpers.js";

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
vi.mock("../chrome.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../chrome.js")>()),
  getChromeWebSocketEndpoint: async () => ({ url: "ws://127.0.0.1:18800/devtools/browser/test" }),
}));
vi.mock("../pw-session-connection.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../pw-session-connection.js")>()),
  getPageForTargetId: () => getPwToolsCoreSessionMocks().getPageForTargetId(),
}));
vi.mock("../pw-ai-module.js", () => ({
  getPwAiModule: async () => ({
    ...(await import("../pw-tools-core.state.js")),
    ...(await import("../pw-tools-core.storage.js")),
    ...(await import("../pw-session-actions.js")),
    getPageForTargetId: getPwToolsCoreSessionMocks().getPageForTargetId,
  }),
}));

import {
  assertBrowserDashboardTargetCurrent,
  requestBrowserDashboard,
  stopBrowserDashboard,
} from "../../browser-dashboard.js";
import { registerBrowserAgentStorageRoutes } from "./agent.storage.js";
import { registerBrowserPermissionRoutes } from "./permissions.js";
import { registerBrowserTabRoutes } from "./tabs.js";

installPwToolsCoreTestHooks();
const sessionKey = "agent:main:dashboard-state-proof";
const request = { sessionKey, agentId: "main", name: "service" };

type MutationCase = {
  name: string;
  route: string;
  body: Record<string, unknown>;
  preparation?: "cdp" | "device queue" | "focus" | "permission socket";
  effects?: number;
};
const mutations: MutationCase[] = [
  { name: "media", route: "/set/media", body: { colorScheme: "dark" } },
  { name: "locale", route: "/set/locale", body: { locale: "en-US" }, preparation: "cdp" },
  { name: "timezone", route: "/set/timezone", body: { timezoneId: "UTC" }, preparation: "cdp" },
  {
    name: "device",
    route: "/set/device",
    body: { name: "Desktop Chrome" },
    preparation: "device queue",
    effects: 4,
  },
  { name: "offline", route: "/set/offline", body: { offline: true } },
  { name: "headers", route: "/set/headers", body: { headers: { "X-Test": "fixture" } } },
  {
    name: "credentials",
    route: "/set/credentials",
    body: { username: "fixture", password: "not-real" },
  },
  {
    name: "geolocation",
    route: "/set/geolocation",
    body: { latitude: 0, longitude: 0 },
    effects: 2,
  },
  {
    name: "cookies set",
    route: "/cookies/set",
    body: { cookie: { name: "theme", value: "dark", url: "http://service.example/" } },
  },
  {
    name: "cookies set-many",
    route: "/cookies/set-many",
    body: { cookies: [{ name: "theme", value: "dark", url: "http://service.example/" }] },
  },
  { name: "cookies clear", route: "/cookies/clear", body: {} },
  { name: "storage set", route: "/storage/:kind/set", body: { key: "theme", value: "dark" } },
  { name: "storage clear", route: "/storage/:kind/clear", body: {} },
  {
    name: "permissions via Playwright",
    route: "/permissions/grant",
    body: { origin: "http://service.example", permissions: ["audioCapture"] },
  },
  {
    name: "permissions via CDP",
    route: "/permissions/grant",
    body: { origin: "http://service.example", permissions: ["clipboardReadWrite"] },
    preparation: "permission socket",
  },
  { name: "focus", route: "/tabs/focus", body: {}, preparation: "focus" },
];

function stateRoute(tab: BrowserTab, spec: MutationCase, hold: () => Promise<void>) {
  const profile = makeBrowserProfile();
  const unused = async (): Promise<never> => {
    throw new Error("Unexpected profile operation");
  };
  const listTabs = async () => {
    if (spec.preparation === "focus") {
      await hold();
    }
    return [tab];
  };
  const selection = createProfileSelectionOps({
    profile,
    runtime: { profile, running: null },
    getCdpControlPolicy: () => undefined,
    listTabs,
    openTab: unused,
  });
  const profileCtx: ProfileContext = {
    profile,
    ensureBrowserAvailable: async () => {},
    ensureTabAvailable: async () => tab,
    isHttpReachable: async () => true,
    isTransportAvailable: async () => true,
    isReachable: async () => true,
    listTabs,
    openTab: unused,
    labelTab: unused,
    focusTab: selection.focusTab,
    closeTab: unused,
    stopRunningBrowser: unused,
    resetProfile: unused,
  };
  const state = makeBrowserServerState({ profile, resolvedOverrides: { ssrfPolicy: undefined } });
  const context: BrowserRouteContext = {
    ...profileCtx,
    state: () => state,
    forProfile: () => profileCtx,
    listProfiles: unused,
    mapTabError: () => null,
  };
  const { app, postHandlers } = createBrowserRouteApp();
  registerBrowserAgentStorageRoutes(app, context);
  registerBrowserPermissionRoutes(app, context);
  registerBrowserTabRoutes(app, context);
  return postHandlers.get(spec.route)!;
}

describe("dashboard state mutation ownership", () => {
  const fixture = useBrowserDashboardTestHarness(browser, sessionKey);
  it.each(
    mutations.flatMap((spec) => [false, true].map((stop) => Object.assign({}, spec, { stop }))),
  )("$name revalidates after preparation with stop=$stop", async (spec) => {
    const dashboard = await requestBrowserDashboard(request);
    const targetId = dashboard.browserTab!.targetId;
    const tab: BrowserTab = { targetId, type: "page", title: "Service", url: dashboard.url };
    const entered = createDeferred<void>();
    const release = createDeferred<void>();
    const closeEntered = createDeferred<void>();
    const releaseClose = createDeferred<{ status: "closed" }>();
    const hold = async () => {
      entered.resolve();
      await release.promise;
    };
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
            await hold();
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
      getPwToolsCoreSessionMocks().getPageForTargetId.mockImplementationOnce(async () => {
        await hold();
        return page;
      });
    } else if (spec.preparation === "device queue") {
      const state = getPwToolsCoreSessionMocks().ensurePageState();
      let tail: Promise<void> | undefined = release.promise;
      Object.assign(state, {
        emulation: {
          get transitionTail() {
            entered.resolve();
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
        await hold();
      }
      return await run(effect);
    });
    browser.closeOwned.mockImplementation(async () => {
      closeEntered.resolve();
      return await releaseClose.promise;
    });
    const response = createBrowserRouteResponse();
    const operation = Promise.resolve(
      stateRoute(
        tab,
        spec,
        hold,
      )(
        {
          params: { kind: "local" },
          query: {},
          body: { ...spec.body, targetId },
          assertCurrent: async (profile) =>
            await assertBrowserDashboardTargetCurrent(dashboard, "main", {}, profile),
        },
        response.res,
      ),
    );
    let retirement: Promise<unknown> | undefined;
    try {
      await Promise.race([
        entered.promise,
        operation.then(() => {
          throw new Error(
            `Mutation ended before preparation: ${response.statusCode} ${JSON.stringify(response.body)}`,
          );
        }),
      ]);
      if (spec.stop) {
        retirement = stopBrowserDashboard(request);
        await Promise.race([
          closeEntered.promise,
          retirement.then(() => {
            throw new Error("Dashboard retirement ended before native close");
          }),
        ]);
      }
      expect(fixture.tabs.map((entry) => entry.targetId)).toContain(targetId);
      release.resolve();
      await operation;
      expect(effect).toHaveBeenCalledTimes(spec.stop ? 0 : (spec.effects ?? 1));
      if (spec.stop) {
        expect(response.statusCode).toBeGreaterThanOrEqual(400);
        expect(response.body).toMatchObject({ error: expect.stringMatching(/dashboard/i) });
      } else {
        expect(response.statusCode).toBe(200);
        expect(response.body).toMatchObject({ ok: true });
      }
    } finally {
      release.resolve();
      releaseClose.resolve({ status: "closed" });
      await Promise.allSettled([operation, retirement]);
    }
  });
});
