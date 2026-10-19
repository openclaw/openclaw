import { expect, it, vi } from "vitest";
import { useBrowserDashboardTestHarness } from "../../browser-dashboard.test-harness.js";
import type { BrowserTab } from "../client.types.js";
import {
  getPwToolsCoreSessionMocks as sessionMocks,
  installPwToolsCoreTestHooks,
  setPwToolsCoreCurrentPage,
} from "../pw-tools-core.test-harness.js";
import { createProfileSelectionOps } from "../server-context.selection.js";
import { atBarrier, gate, startRoute } from "./agent-route.test-support.js";
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
vi.mock("../chrome.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../chrome.js")>()),
  getChromeWebSocketEndpoint: async () => ({ url: "ws://127.0.0.1:18800/devtools/browser/test" }),
}));
vi.mock("../pw-session-connection.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../pw-session-connection.js")>()),
  getPageForTargetId: () => sessionMocks().getPageForTargetId(),
}));
// mock-isolation: Bind real storage and session actions to the suite-owned page, not a global connection.
vi.mock("../pw-ai-module.js", () => ({
  getPwAiModule: async () => ({
    ...(await import("../pw-tools-core.state.js")),
    ...(await import("../pw-tools-core.storage.js")),
    ...(await import("../pw-session-actions.js")),
    getPageForTargetId: sessionMocks().getPageForTargetId,
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
  ["/storage/:kind/set", { key: "theme", value: "dark" }],
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

const fixture = useBrowserDashboardTestHarness(browser, sessionKey);
it.each(
  mutations.flatMap(([route, body = {}, preparation, effects]) =>
    [false, true].map((stop) => ({ route, body, preparation, effects, stop })),
  ),
)("$route/$preparation revalidates with stop=$stop", async (spec) => {
  const dashboard = await requestBrowserDashboard(request);
  const targetId = dashboard.browserTab!.targetId;
  const tab: BrowserTab = { targetId, type: "page", title: "Service", url: dashboard.url };
  const ready = gate();
  const closing = gate<{ status: "closed" }>();
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
    sessionMocks().getPageForTargetId.mockImplementationOnce(() => ready.block().then(() => page));
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
  const { response, completion: operation } = startRoute(stateRoute(tab, spec.route, beforeFocus), {
    params: { kind: "local" },
    body: { ...spec.body, targetId },
    assertCurrent: (profile) => assertBrowserDashboardTargetCurrent(dashboard, "main", {}, profile),
  });
  let retirement: Promise<unknown> | undefined;
  try {
    await atBarrier(ready.entered, operation, "mutation ended before preparation", response);
    if (spec.stop) {
      retirement = stopBrowserDashboard(request);
      await atBarrier(closing.entered, retirement, "retired before native close");
    }
    expect(fixture.tabs.map((entry) => entry.targetId)).toContain(targetId);
    ready.resolve();
    await operation;
    expect(effect).toHaveBeenCalledTimes(spec.stop ? 0 : (spec.effects ?? 1));
    if (spec.stop) {
      expect(response.statusCode).toBeGreaterThanOrEqual(400);
      expect(response.body).toMatchObject({ error: expect.stringMatching(/dashboard/i) });
    } else {
      expect(response).toMatchObject({ statusCode: 200, body: { ok: true } });
    }
  } finally {
    ready.resolve();
    closing.resolve({ status: "closed" });
    await Promise.allSettled([operation, retirement]);
  }
});
