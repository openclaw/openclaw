import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { GatewayRequestHandlers } from "openclaw/plugin-sdk/gateway-runtime";
import {
  createPluginStateKeyedStoreForTests,
  createPluginStateSyncKeyedStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import {
  createPluginRuntimeMock,
  createTestGatewayRequestContext,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { setRuntimeConfigSnapshot } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { rawDataToString } from "openclaw/plugin-sdk/webhook-ingress";
import { WebSocketServer } from "openclaw/plugin-sdk/websocket-runtime";
import { expect, vi } from "vitest";
import { registerBrowserPlugin } from "../../plugin-registration.js";
import { withBrowserFetchPreconnect } from "../../test-fetch.js";
import { getBrowserStateRuntime } from "../browser-runtime-state.js";
import * as cdpHelpers from "../browser/cdp.helpers.js";
import * as cdp from "../browser/cdp.js";
import type { BrowserTab } from "../browser/client.types.js";
import { createBrowserRouteContext } from "../browser/server-context.js";
import { makeBrowserServerState } from "../browser/server-context.test-harness.js";
import { volatileTabsBySession } from "../browser/session-tab-process-state.js";

type NodeInvoke = Parameters<
  GatewayRequestHandlers[string]
>[0]["context"]["nodeRegistry"]["invoke"];
export type SessionTabsTestMockFunctions = {
  nodeGatewayCall: (
    method: string,
    options: unknown,
    envelope: Parameters<NodeInvoke>[0],
    callOptions?: { signal?: AbortSignal },
  ) => ReturnType<NodeInvoke>;
  mcpList: (name?: string) => Promise<BrowserTab[]>;
  mcpOpen: (name: string, url: string) => Promise<BrowserTab>;
  mcpClose: (name: string, targetId: string) => Promise<void>;
};

export type SessionTabsTestState = {
  generations: Map<string, string>;
  revisions: Map<string, string>;
  beforeCapture: ReturnType<typeof vi.fn<() => Promise<void>>>;
  beforeList: ReturnType<typeof vi.fn<() => Promise<void>>>;
  nodeGatewayCall: ReturnType<typeof vi.fn<SessionTabsTestMockFunctions["nodeGatewayCall"]>>;
  borrows: Array<{
    sessionKey: string;
    controller: AbortController;
    release: ReturnType<typeof vi.fn>;
  }>;
  mcpList: ReturnType<typeof vi.fn<SessionTabsTestMockFunctions["mcpList"]>>;
  mcpOpen: ReturnType<typeof vi.fn<SessionTabsTestMockFunctions["mcpOpen"]>>;
  mcpClose: ReturnType<typeof vi.fn<SessionTabsTestMockFunctions["mcpClose"]>>;
  context: ReturnType<typeof createBrowserRouteContext> | undefined;
};

const nativeCloseTrackedTarget = cdpHelpers.closeTrackedCdpTarget;
const nativeResolveOwnership = cdpHelpers.resolveCdpTabOwnership;

export async function requireEntry(entered: Promise<void>, pending: Promise<unknown>) {
  await Promise.race([
    entered,
    pending.then((result) => {
      throw new Error("Operation settled before deferred entry: " + JSON.stringify(result));
    }),
  ]);
}

export async function createSessionTabsTestFixture(
  driver: "openclaw" | "existing-session",
  fixture: SessionTabsTestState,
) {
  async function captureSessionLifetime(sessionKey: string) {
    await fixture.beforeCapture();
    const sessionId = fixture.generations.get(sessionKey);
    if (!sessionId) {
      throw new Error("Session unavailable");
    }
    const lifecycleRevision = fixture.revisions.get(sessionKey);
    const assertCurrent = () => {
      if (
        fixture.generations.get(sessionKey) !== sessionId ||
        fixture.revisions.get(sessionKey) !== lifecycleRevision
      ) {
        throw new Error("Session replaced");
      }
    };
    return {
      target: { sessionKey, sessionId, agentId: "main", lifecycleRevision },
      assertCurrent,
      retain: () => {
        assertCurrent();
        const controller = new AbortController();
        const release = vi.fn();
        fixture.borrows.push({ sessionKey, controller, release });
        return { signal: controller.signal, assertCurrent, release };
      },
    };
  }

  fixture.revisions.clear();
  fixture.borrows.length = 0;
  fixture.beforeCapture.mockReset().mockResolvedValue(undefined);
  fixture.beforeList.mockReset().mockResolvedValue(undefined);
  const originalFetch = globalThis.fetch;
  const state = makeBrowserServerState();
  const configuredProfile = state.resolved.profiles.openclaw;
  if (!configuredProfile) {
    throw new Error("Missing configured profile");
  }
  configuredProfile.driver = driver;
  fixture.context = createBrowserRouteContext({ getState: () => state });
  setRuntimeConfigSnapshot({
    gateway: { nodes: { browser: { mode: "off" } } },
    browser: {
      defaultProfile: "openclaw",
      profiles: { openclaw: { driver, cdpPort: 18800, color: "#FF4500" } },
    },
  });
  const methods = new Map<string, GatewayRequestHandlers[string]>();
  const generations = (fixture.generations = new Map([
    ["agent:main:a", "generation-a"],
    ["agent:main:b", "generation-b"],
  ]));
  const readStandalone =
    vi.fn<NonNullable<ReturnType<typeof getBrowserStateRuntime>["getSessionEntryAsync"]>>();
  const pluginRuntime = createPluginRuntimeMock({
    state: {
      openSyncKeyedStore: (options) => createPluginStateSyncKeyedStoreForTests("browser", options),
      openKeyedStore: (options) => createPluginStateKeyedStoreForTests("browser", options),
    },
    gateway: { isAvailable: async () => true, captureSessionLifetime },
    agent: { session: { getSessionEntryAsync: readStandalone } },
  });
  const agentRuntime = pluginRuntime.agent;
  const getAgentRuntime = vi.fn(() => agentRuntime);
  Object.defineProperty(pluginRuntime, "agent", { get: getAgentRuntime });
  registerBrowserPlugin(
    createTestPluginApi({
      id: "browser",
      runtime: pluginRuntime,
      registerGatewayMethod: (name, handler, options) => {
        if (name === "browser.request") {
          expect(options).toEqual({ scope: "operator.admin" });
        }
        methods.set(name, handler);
      },
    }),
  );
  expect(getAgentRuntime).not.toHaveBeenCalled();
  const handler = methods.get("browser.request");
  if (!handler) {
    throw new Error("browser.request was not registered");
  }
  let nextId = 0;
  let browserInstance = "browser-one";
  let closeBrowserWebSocketUrl: string | undefined;
  const tabs: Array<{
    id: string;
    title: string;
    url: string;
    type: string;
    webSocketDebuggerUrl: string;
    openerId?: string;
  }> = [];
  const closed: string[] = [];
  fixture.mcpList.mockImplementation(async () =>
    tabs.map((tab) => ({
      targetId: tab.id,
      title: tab.title,
      url: tab.url,
      type: tab.type,
    })),
  );
  fixture.mcpOpen.mockImplementation(async (_name: string, url: string) => {
    const targetId = "native-" + ++nextId;
    tabs.push({
      id: targetId,
      title: "Same title",
      url,
      type: "page",
      webSocketDebuggerUrl: "",
    });
    return { targetId, title: "Same title", url, type: "page" };
  });
  fixture.mcpClose.mockImplementation(async (_name: string, targetId: string) => {
    closed.push(targetId);
    const index = tabs.findIndex((tab) => tab.id === targetId);
    if (index >= 0) {
      tabs.splice(index, 1);
    }
  });
  await getBrowserStateRuntime().sessionTabDiscovery.entries();
  const syncStore = getBrowserStateRuntime().sessionTabs;
  const syncReads = vi.spyOn(syncStore, "entries");
  const syncWrites = vi.spyOn(syncStore, "register");
  vi.spyOn(cdp, "createTargetViaCdp").mockImplementation(async ({ url }) => {
    const targetId = "native-" + ++nextId;
    tabs.push({
      id: targetId,
      title: "Same title",
      url,
      type: "page",
      webSocketDebuggerUrl: "ws://127.0.0.1:18800/devtools/page/" + targetId,
    });
    return { targetId, finalUrl: url };
  });
  vi.spyOn(cdpHelpers, "resolveCdpTabOwnership").mockImplementation(async ({ nativeTargetId }) => ({
    status: "durable",
    nativeTargetId,
    profileFingerprint: "profile-one",
    browserInstanceFingerprint: browserInstance,
  }));
  vi.spyOn(cdpHelpers, "closeTrackedCdpTarget").mockImplementation(
    async ({ nativeTargetId, expectedBrowserInstanceFingerprint }) => {
      if (expectedBrowserInstanceFingerprint !== browserInstance) {
        return { status: "ownership-mismatch" };
      }
      const index = tabs.findIndex((tab) => tab.id === nativeTargetId);
      if (index < 0) {
        return { status: "missing" };
      }
      closed.push(nativeTargetId);
      tabs.splice(index, 1);
      return { status: "closed" };
    },
  );
  vi.spyOn(cdpHelpers, "readCdpSessionTabInventory").mockImplementation(
    async ({ nativeTargetId }) => ({
      ownership: {
        status: "durable",
        nativeTargetId,
        profileFingerprint: "profile-one",
        browserInstanceFingerprint: browserInstance,
      },
      openers: new Map(tabs.flatMap((tab) => (tab.openerId ? [[tab.id, tab.openerId]] : []))),
    }),
  );
  globalThis.fetch = withBrowserFetchPreconnect(
    vi.fn(async (url: unknown) => {
      const path = new URL(String(url)).pathname;
      if (path === "/json/version" && closeBrowserWebSocketUrl) {
        return Response.json({ webSocketDebuggerUrl: closeBrowserWebSocketUrl });
      }
      if (path === "/json/list") {
        await fixture.beforeList();
        return { ok: true, json: async () => tabs } as Response;
      }
      if (path.startsWith("/json/activate/")) {
        return { ok: true } as Response;
      }
      if (path.startsWith("/json/close/")) {
        const id = path.slice("/json/close/".length);
        closed.push(id);
        const index = tabs.findIndex((tab) => tab.id === id);
        if (index >= 0) {
          tabs.splice(index, 1);
        }
        return { ok: true } as Response;
      }
      throw new Error("unexpected native request: " + path);
    }),
  );
  const hostRequestContext = await createTestGatewayRequestContext();
  const request = async (
    sessionKey: string | undefined,
    method: string,
    path: string,
    body?: unknown,
  ) => {
    const respond = vi.fn();
    await handler({
      req: { type: "req", id: "session-test", method: "browser.request" },
      params: { target: "host", ...(sessionKey ? { sessionKey } : {}), method, path, body },
      respond,
      context: hostRequestContext,
      client: null,
      isWebchatConnect: () => false,
    });
    const result = respond.mock.calls[0];
    if (!result) {
      throw new Error("No browser response");
    }
    return result;
  };
  const withNativeClosePreparation = async (
    targetId: string,
    run: (
      ownership: Extract<Awaited<ReturnType<typeof nativeResolveOwnership>>, { status: "durable" }>,
      entered: Promise<void>,
      proceed: () => void,
    ) => Promise<void>,
  ) => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve) => {
      server.once("listening", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Native fixture did not bind TCP");
    }
    const entered = createDeferred<void>();
    const proceed = createDeferred<void>();
    const closes = vi.fn();
    const pendingMessages: Promise<void>[] = [];
    server.on("connection", (socket) => {
      socket.on("message", (data) => {
        const work = (async () => {
          const message = JSON.parse(rawDataToString(data));
          if (message.method === "Target.getTargets") {
            entered.resolve();
            await proceed.promise;
            socket.send(
              JSON.stringify({
                id: message.id,
                result: { targetInfos: [{ targetId, type: "page" }] },
              }),
            );
          } else if (message.method === "Target.closeTarget") {
            closes();
            closed.push(targetId);
            const index = tabs.findIndex((tab) => tab.id === targetId);
            if (index >= 0) {
              tabs.splice(index, 1);
            }
            socket.send(JSON.stringify({ id: message.id, result: { success: true } }));
          }
        })();
        pendingMessages.push(work);
        void work.catch((error: unknown) => {
          entered.reject(error);
          socket.terminate();
        });
      });
    });
    const mockedClose = vi.mocked(cdpHelpers.closeTrackedCdpTarget).getMockImplementation();
    if (!mockedClose) {
      throw new Error("Mock close missing");
    }
    closeBrowserWebSocketUrl = "ws://127.0.0.1:" + address.port + "/devtools/browser/leaf-test";
    try {
      const ownership = await nativeResolveOwnership({
        profileName: "openclaw",
        cdpUrl: "http://127.0.0.1:18800",
        nativeTargetId: targetId,
      });
      if (ownership.status !== "durable") {
        throw new Error("Native fixture ownership unavailable");
      }
      vi.mocked(cdpHelpers.closeTrackedCdpTarget).mockImplementation(nativeCloseTrackedTarget);
      await run(ownership, entered.promise, proceed.resolve);
      expect(closes).not.toHaveBeenCalled();
    } finally {
      proceed.resolve();
      closeBrowserWebSocketUrl = undefined;
      vi.mocked(cdpHelpers.closeTrackedCdpTarget).mockImplementation(mockedClose);
      for (const socket of server.clients) {
        socket.terminate();
      }
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      await Promise.all(pendingMessages);
    }
  };
  return {
    fixture,
    state,
    handler,
    generations,
    readStandalone,
    tabs,
    closed,
    syncReads,
    syncWrites,
    request,
    withNativeClosePreparation,
    get nextId() {
      return nextId;
    },
    setBrowserInstance(value: string) {
      browserInstance = value;
    },
    cleanup() {
      globalThis.fetch = originalFetch;
      volatileTabsBySession().clear();
      vi.restoreAllMocks();
      fixture.context = undefined;
    },
  };
}
export type SessionTabsTestFixture = Awaited<ReturnType<typeof createSessionTabsTestFixture>>;
