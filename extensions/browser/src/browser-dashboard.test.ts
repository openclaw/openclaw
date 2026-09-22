import { AsyncLocalStorage } from "node:async_hooks";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type {
  OpenClawPluginService,
  OpenClawPluginServiceContext,
  OpenClawPluginGatewayEvents,
} from "openclaw/plugin-sdk/plugin-entry";
import type { OpenKeyedStoreOptions } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateSyncKeyedStoreForTests,
  createPluginStateKeyedStoreForTests,
  openOpenClawStateDatabase,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import type { PluginRuntime } from "openclaw/plugin-sdk/runtime-store";
import { describe, expect, it, vi } from "vitest";
import { registerBrowserPlugin } from "../plugin-registration.js";
import { useBrowserDashboardTestHarness } from "./browser-dashboard.test-harness.js";
import { handleBrowserGatewayRequest } from "./gateway/browser-request.js";

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

import {
  inspectBrowserDashboard,
  reconcileBrowserDashboards,
  requestBrowserDashboard,
  stopBrowserDashboard,
  assertBrowserDashboardTargetCurrent,
} from "./browser-dashboard.js";
import { BROWSER_TAB_UNREACHABLE_RETIRE_MS } from "./browser/constants.js";
import { registerBrowserTabRoutes } from "./browser/routes/tabs.js";
import {
  createBrowserRouteApp,
  createBrowserRouteResponse,
} from "./browser/routes/test-helpers.js";
import type { BrowserRouteContext } from "./browser/server-context.js";
import { makeBrowserProfile } from "./browser/server-context.test-harness.js";
import {
  closeTrackedBrowserTabsForSessions,
  sweepTrackedBrowserTabs,
} from "./browser/session-tab-registry.js";
import {
  assertBrowserDashboardTabCanClose,
  browserSessionTabStorageKey,
  type BrowserSessionTabRecord,
  getBrowserSessionTabStore,
  parseBrowserSessionTabRecord,
  readBrowserDashboardTabs,
} from "./browser/session-tab-store.js";

const sessionKey = "agent:main:browser-dashboard-proof";
const request = { sessionKey, agentId: "main", name: "service" };

describe("Browser dashboard lifetime", () => {
  const fixture = useBrowserDashboardTestHarness(browser, sessionKey);

  it("shares one HTTP target across simultaneous views, plugin reload, idle sweep, and transcript reset", async () => {
    const [first, second] = await Promise.all([
      requestBrowserDashboard(request),
      requestBrowserDashboard({ sessionKey, name: "service" }),
    ]);
    expect(first.browserTab).toEqual({ target: "host", profile: "openclaw", targetId: "target-1" });
    expect(second.browserTab).toEqual(first.browserTab);
    expect(browser.open).toHaveBeenCalledOnce();
    expect(browser.open).toHaveBeenCalledWith(
      undefined,
      "http://service.example/",
      expect.objectContaining({ profile: "openclaw", managedOnly: true }),
    );
    fixture.installRuntime();
    expect((await requestBrowserDashboard(request)).browserTab).toEqual(first.browserTab);
    await sweepTrackedBrowserTabs({
      idleMs: 1,
      maxTabsPerSession: 1,
      now: Date.now() + 86_400_000,
    });
    await closeTrackedBrowserTabsForSessions({ sessionKeys: [sessionKey] });
    expect(fixture.tabs.map((tab) => tab.targetId)).toEqual(["target-1"]);
    expect(() => assertBrowserDashboardTabCanClose("target-1", "openclaw")).toThrow(
      /belongs to dashboard service/,
    );
    expect(browser.closeOwned).not.toHaveBeenCalled();
  });

  it.each(["cold", "warm"] as const)(
    "persists %s Stop across reload and resumes only on request",
    async (state) => {
      if (state === "warm") {
        await requestBrowserDashboard(request);
      }
      expect((await stopBrowserDashboard(request)).paused).toBe(true);
      expect(fixture.tabs).toEqual([]);
      expect((await inspectBrowserDashboard(request)).paused).toBe(true);
      if (state === "cold") {
        const store = getBrowserSessionTabStore();
        store.register("dashboard-stop:forged", store.entries()[0]?.value);
      }
      await sweepTrackedBrowserTabs({
        idleMs: 1,
        maxTabsPerSession: 1,
        now: Date.now() + 86_400_000,
      });
      expect(getBrowserSessionTabStore().entries()).toHaveLength(1);
      fixture.installRuntime();
      expect((await requestBrowserDashboard(request)).paused).toBe(true);
      expect(browser.open).toHaveBeenCalledTimes(state === "cold" ? 0 : 1);
      if (state === "cold") {
        expect(readBrowserDashboardTabs()).toEqual([]);
        expect(getBrowserSessionTabStore().entries()[0]?.value).toMatchObject({
          kind: "dashboard-stop",
        });
      }
      const resumed = await requestBrowserDashboard({ ...request, resume: true });
      expect(resumed.browserTab?.targetId).toBe(state === "cold" ? "target-1" : "target-2");
      expect(resumed.paused).toBe(false);
      expect(fixture.widgets[0]?.props).toEqual({ url: "http://service.example/" });
      expect(getBrowserSessionTabStore().entries()).toHaveLength(1);
    },
  );

  it.each([
    ["stopped", "cancelled"],
    ["stopped", "registration failed"],
    ["stopping", "cancelled"],
    ["stopping", "registration failed"],
    ["cold", "cancelled"],
    ["cold", "registration failed"],
  ] as const)("preserves %s intent after Resume failure: %s", async (state, failure) => {
    if (state !== "cold") {
      await requestBrowserDashboard(request);
    }
    if (state === "stopping") {
      browser.closeOwned.mockResolvedValueOnce({
        status: "unavailable",
        reason: "browser-identity-lookup-failed",
      });
      await expect(stopBrowserDashboard(request)).rejects.toThrow(/paused/);
    } else {
      await stopBrowserDashboard(request);
    }
    const controller = new AbortController();
    const error = new Error(`Resume ${failure}`);
    const store = getBrowserSessionTabStore();
    const update = store.update!;
    const writeSpy = vi.spyOn(store, "update").mockImplementation((key, patch) =>
      update(key, (current) => {
        const next = patch(current);
        if (
          failure === "registration failed" &&
          parseBrowserSessionTabRecord(next)?.dashboard?.state === "active"
        ) {
          throw error;
        }
        return next;
      }),
    );
    browser.open.mockImplementationOnce(async () => {
      const tab = fixture.openedTab();
      if (failure === "cancelled") {
        fixture.readBoard.mockImplementationOnce(async () =>
          structuredClone({ sessionKey, widgets: fixture.widgets }),
        );
        fixture.readBoard.mockImplementationOnce(async () => {
          controller.abort(error);
          return structuredClone({ sessionKey, widgets: fixture.widgets });
        });
      }
      return tab;
    });
    try {
      await expect(
        requestBrowserDashboard({ ...request, resume: true }, { signal: controller.signal }),
      ).rejects.toThrow(
        failure === "cancelled" ? error.message : "Failed to update plugin state entry.",
      );
    } finally {
      writeSpy.mockRestore();
    }
    expect(fixture.tabs).toEqual([]);
    expect((await inspectBrowserDashboard(request)).paused).toBe(true);
    expect((await requestBrowserDashboard(request)).paused).toBe(true);
    expect(browser.open).toHaveBeenCalledTimes(state === "cold" ? 1 : 2);
    expect(getBrowserSessionTabStore().entries()).toHaveLength(1);
    expect((await requestBrowserDashboard({ ...request, resume: true })).paused).toBe(false);
  });

  it.each(["removed", "session deleted", "replaced", "URL changed", "profile changed"] as const)(
    "retires cold Stop intent when the definition is %s without starting a browser",
    async (change) => {
      await stopBrowserDashboard(request);
      if (change === "removed" || change === "session deleted") {
        fixture.widgets = [];
      } else if (change === "replaced") {
        fixture.widgets[0]!.instanceId = "instance-two";
      } else if (change === "URL changed") {
        fixture.widgets[0]!.props.url = "http://updated.example/";
      } else {
        fixture.widgets[0]!.props.profile = "other-managed";
      }
      if (change === "session deleted") {
        await closeTrackedBrowserTabsForSessions({ sessionKeys: [sessionKey] });
      } else {
        await sweepTrackedBrowserTabs({ ordinaryCleanup: false });
      }
      expect(getBrowserSessionTabStore().entries()).toEqual([]);
      expect(browser.open).not.toHaveBeenCalled();
      expect(browser.closeOwned).not.toHaveBeenCalled();
    },
  );

  it.each(["cold", "warm"] as const)(
    "prefers an active target while %s stopped-marker retirement retries",
    async (state) => {
      if (state === "warm") {
        await requestBrowserDashboard(request);
      }
      await stopBrowserDashboard(request);
      const retirement = vi
        .spyOn(getBrowserSessionTabStore(), "deleteIf")
        .mockReturnValueOnce(false);
      let resumed;
      try {
        resumed = await requestBrowserDashboard({ ...request, resume: true });
      } finally {
        retirement.mockRestore();
      }
      expect(getBrowserSessionTabStore().entries()).toHaveLength(2);
      expect((await inspectBrowserDashboard(request)).browserTab).toEqual(resumed.browserTab);
      expect((await requestBrowserDashboard(request)).browserTab).toEqual(resumed.browserTab);
      await sweepTrackedBrowserTabs({ ordinaryCleanup: false });
      expect(getBrowserSessionTabStore().entries()).toHaveLength(1);
      expect(fixture.tabs.map((tab) => tab.targetId)).toEqual([resumed.browserTab?.targetId]);
    },
  );

  it("preserves a newer cold Stop when an older reconciliation finishes", async () => {
    await stopBrowserDashboard(request);
    fixture.widgets[0]!.props.url = "http://updated.example/";
    const reading = createDeferred<void>();
    const finish = createDeferred<void>();
    fixture.readBoard.mockImplementationOnce(async () => {
      const snapshot = structuredClone({ sessionKey, widgets: fixture.widgets });
      reading.resolve();
      await finish.promise;
      return snapshot;
    });
    const reconciling = sweepTrackedBrowserTabs({ ordinaryCleanup: false });
    try {
      await Promise.race([
        reading.promise,
        reconciling.then(() => {
          throw new Error("Cold-intent cleanup skipped the definition lookup");
        }),
      ]);
      await stopBrowserDashboard(request);
      const retained = getBrowserSessionTabStore().entries();
      finish.resolve();
      await reconciling;
      expect(getBrowserSessionTabStore().entries()).toEqual(retained);
    } finally {
      finish.resolve();
      await reconciling;
    }
    fixture.installRuntime();
    expect((await requestBrowserDashboard(request)).paused).toBe(true);
    expect(browser.open).not.toHaveBeenCalled();
  });

  it.each(["removed", "invalid URL", "invalid profile"] as const)(
    "reconciles %s definitions even when ordinary tab cleanup is disabled",
    async (condition) => {
      await requestBrowserDashboard(request);
      if (condition === "removed") {
        fixture.widgets = [];
      } else if (condition === "invalid URL") {
        fixture.widgets[0]!.props.url = "ftp://service.example/";
      } else {
        fixture.widgets[0]!.props.profile = " ";
      }
      await expect(sweepTrackedBrowserTabs({ ordinaryCleanup: false })).resolves.toBe(1);
      expect(fixture.tabs).toEqual([]);
      expect(readBrowserDashboardTabs()).toEqual([]);
      expect(browser.closeOwned).toHaveBeenCalledOnce();
      if (condition !== "removed") {
        await expect(requestBrowserDashboard(request)).rejects.toThrow(/widget_put/);
      }
    },
  );

  it("retains a target when authoritative board lookup is unavailable", async () => {
    await requestBrowserDashboard(request);
    fixture.readBoard.mockRejectedValueOnce(new Error("Gateway unavailable"));
    const onWarn = vi.fn();
    await sweepTrackedBrowserTabs({ ordinaryCleanup: false, onWarn });
    expect(fixture.tabs).toHaveLength(1);
    expect(browser.closeOwned).not.toHaveBeenCalled();
    expect(onWarn).toHaveBeenCalledWith(
      expect.stringContaining("Could not reconcile Browser dashboard service"),
    );
  });

  it.each(["ownership", "reachability"] as const)(
    "preserves the live page when its %s probe is unavailable",
    async (probe) => {
      const opened = await requestBrowserDashboard(request);
      const retainedPage = fixture.tabs[0]!;
      retainedPage.url = "http://service.example/unfinished-work";
      retainedPage.title = "Unsubmitted draft";
      const retainedRows = readBrowserDashboardTabs();
      if (probe === "ownership") {
        browser.ownership.mockResolvedValueOnce({
          status: "non-durable",
          reason: "browser-identity-lookup-failed",
        });
      } else {
        browser.tabs.mockResolvedValueOnce({ running: false, tabs: [] });
      }
      await expect(requestBrowserDashboard(request)).rejects.toThrow(
        /Retry.*existing tab has been kept/,
      );
      expect(fixture.tabs).toEqual([retainedPage]);
      expect(browser.closeOwned.mock.calls.map(([args]) => args.nativeTargetId)).toEqual(
        probe === "ownership" ? [] : ["target-2"],
      );
      expect(readBrowserDashboardTabs()).toEqual(retainedRows);
      expect((await requestBrowserDashboard(request)).browserTab).toEqual(opened.browserTab);
      expect(browser.open).toHaveBeenCalledTimes(probe === "ownership" ? 1 : 2);
      expect(retainedPage.url).toBe("http://service.example/unfinished-work");
    },
  );

  it("preserves Gateway invocation cancellation while opening a dashboard without a WebSocket client", async () => {
    const started = createDeferred<void>();
    const finish = createDeferred<void>();
    browser.open.mockImplementationOnce(async () => {
      started.resolve();
      await finish.promise;
      return fixture.openedTab();
    });
    const controller = new AbortController();
    const respond = vi.fn();
    const opening = handleBrowserGatewayRequest({
      params: { target: "host", method: "POST", path: "/dashboard", body: request },
      respond: respond as never,
      context: {} as never,
      client: null,
      req: { type: "req", id: "dashboard-in-process", method: "browser.request" },
      isWebchatConnect: () => false,
      signal: controller.signal,
    });
    await started.promise;
    controller.abort(new Error("agent turn cancelled"));
    finish.resolve();
    await opening;
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: expect.stringContaining("agent turn cancelled") }),
    );
    expect(fixture.tabs).toEqual([]);
    expect(readBrowserDashboardTabs()).toEqual([]);
  });

  it("preserves canonical board identity when its opaque session tail is case-sensitive", async () => {
    const opaqueKey = "agent:main:discord:channel:OpaqueCase";
    fixture.readBoard.mockImplementation(async (_method, params) => {
      expect(params.sessionKey).toBe(opaqueKey);
      return structuredClone({ sessionKey: opaqueKey, widgets: fixture.widgets });
    });
    const first = await requestBrowserDashboard({ ...request, sessionKey: opaqueKey });
    fixture.installRuntime();
    expect(
      (await requestBrowserDashboard({ sessionKey: opaqueKey, name: "service" })).browserTab,
    ).toEqual(first.browserTab);
    expect(browser.open).toHaveBeenCalledOnce();
    expect(readBrowserDashboardTabs()[0]?.dashboard?.sessionKey).toBe(opaqueKey);
  });

  it.each(["replacement", "stopped", "missing target"] as const)(
    "recovers from browser %s while preserving unrelated pages",
    async (condition) => {
      await requestBrowserDashboard(request);
      if (condition === "replacement") {
        fixture.browserInstance = "browser-two";
      } else {
        fixture.browserRunning = condition !== "stopped";
        fixture.tabs = [];
      }
      const recovered = await requestBrowserDashboard({ ...request, resume: true });
      expect(recovered.browserTab?.targetId).toBe("target-2");
      expect(fixture.browserRunning).toBe(true);
      expect(fixture.tabs.map((tab) => tab.targetId)).toEqual(
        condition === "replacement" ? ["target-1", "target-2"] : ["target-2"],
      );
      expect(readBrowserDashboardTabs()).toHaveLength(1);
      expect(readBrowserDashboardTabs()[0]?.browserInstanceFingerprint).toBe(
        fixture.browserInstance,
      );
    },
  );

  it("rejects a native dashboard request when the browser instance changes behind the same target ID", async () => {
    await requestBrowserDashboard(request);
    const saved = await inspectBrowserDashboard(request);
    fixture.browserInstance = "browser-two";
    const profile = makeBrowserProfile({ cdpUrl: "http://127.0.0.1:19991", cdpPort: 19991 });
    const isReachable = vi.fn(async () => true);
    const listTabs = vi.fn(async () => fixture.tabs);
    const { app, getHandlers } = createBrowserRouteApp();
    registerBrowserTabRoutes(app, {
      forProfile: () => ({ profile, isReachable, listTabs }),
      mapTabError: () => null,
    } as unknown as BrowserRouteContext);
    const response = createBrowserRouteResponse();
    await getHandlers.get("/tabs")!(
      {
        params: {},
        query: { profile: "openclaw", managedOnly: true },
        assertCurrent: (actualProfile) =>
          assertBrowserDashboardTargetCurrent(saved, "main", {}, actualProfile),
      },
      response.res,
    );
    expect(response.statusCode).toBe(500);
    expect(response.body).toMatchObject({
      error: expect.stringContaining("browser instance changed"),
    });
    expect(browser.ownership).toHaveBeenLastCalledWith(
      expect.objectContaining({ cdpUrl: profile.cdpUrl, nativeTargetId: "target-1" }),
    );
    expect(isReachable).not.toHaveBeenCalled();
    expect(listTabs).not.toHaveBeenCalled();
  });

  it("retains failed stale-creation cleanup and retries it after the browser recovers", async () => {
    browser.open.mockImplementationOnce(async () => {
      const tab = fixture.openedTab();
      fixture.widgets = [];
      return tab;
    });
    browser.closeOwned.mockResolvedValueOnce({
      status: "unavailable",
      reason: "target-close-failed",
    });
    await expect(requestBrowserDashboard(request)).rejects.toThrow(
      /retained cleanup record will retry/,
    );
    expect(fixture.tabs).toHaveLength(1);
    expect(readBrowserDashboardTabs()).toEqual([
      expect.objectContaining({
        nativeTargetId: "target-1",
        profileFingerprint: "profile-one",
        browserInstanceFingerprint: "browser-one",
        dashboard: expect.objectContaining({ state: "released" }),
      }),
    ]);
    await expect(sweepTrackedBrowserTabs({ ordinaryCleanup: false })).resolves.toBe(1);
    expect(fixture.tabs).toEqual([]);
    expect(readBrowserDashboardTabs()).toEqual([]);
  });

  it.each(["Stop", "removal"] as const)(
    "retains cleanup after long idle time when %s temporarily fails",
    async (action) => {
      await requestBrowserDashboard(request);
      const clock = vi
        .spyOn(Date, "now")
        .mockReturnValue(Date.now() + BROWSER_TAB_UNREACHABLE_RETIRE_MS * 2);
      try {
        browser.closeOwned.mockResolvedValueOnce({
          status: "unavailable",
          reason: "target-close-failed",
        });
        if (action === "Stop") {
          await expect(stopBrowserDashboard(request)).rejects.toThrow(
            /paused, but its browser tab could not close/,
          );
          expect(await inspectBrowserDashboard(request)).toMatchObject({
            paused: true,
            stopping: true,
          });
        } else {
          fixture.widgets = [];
          await expect(sweepTrackedBrowserTabs({ ordinaryCleanup: false })).resolves.toBe(0);
        }
        expect(fixture.tabs.map((tab) => tab.targetId)).toEqual(["target-1"]);
        expect(readBrowserDashboardTabs()).toEqual([
          expect.objectContaining({
            nativeTargetId: "target-1",
            cleanupAttemptToken: expect.any(String),
            dashboard: expect.objectContaining({
              state: action === "Stop" ? "stopping" : "released",
            }),
          }),
        ]);
        await expect(sweepTrackedBrowserTabs({ ordinaryCleanup: false })).resolves.toBe(1);
        expect(fixture.tabs).toEqual([]);
        if (action === "Stop") {
          expect(readBrowserDashboardTabs()[0]?.dashboard?.state).toBe("stopped");
          expect(await inspectBrowserDashboard(request)).toMatchObject({
            paused: true,
            stopping: false,
          });
          const resumed = await requestBrowserDashboard({ ...request, resume: true });
          expect(resumed.browserTab?.targetId).toBe("target-2");
          expect(fixture.tabs.map((tab) => tab.targetId)).toEqual(["target-2"]);
        } else {
          expect(readBrowserDashboardTabs()).toEqual([]);
        }
      } finally {
        clock.mockRestore();
      }
    },
  );

  it("publishes changed lifetimes and drains board-change cleanup through the existing service events", async () => {
    const serviceScope = new AsyncLocalStorage<string>();
    const services: OpenClawPluginService[] = [];
    let boardChanged: Parameters<OpenClawPluginGatewayEvents["onSessionsChanged"]>[0] | undefined;
    const emit = vi.fn();
    const unsubscribe = vi.fn();
    const on = vi.fn();
    registerBrowserPlugin(
      createTestPluginApi({
        id: "browser",
        name: "Browser",
        source: "test",
        rootDir: fixture.stateDir,
        config: {},
        on,
        runtime: {
          state: {
            openSyncKeyedStore: (options: OpenKeyedStoreOptions) =>
              createPluginStateSyncKeyedStoreForTests("browser", options),
            openKeyedStore: (options: OpenKeyedStoreOptions) =>
              createPluginStateKeyedStoreForTests("browser", options),
          },
          gateway: { isAvailable: async () => true, request: fixture.readBoard },
        } as unknown as PluginRuntime,
        registerService: (value) => {
          services.push(value);
        },
      }),
    );
    const context: OpenClawPluginServiceContext = {
      config: {},
      stateDir: fixture.stateDir,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      gatewayEvents: {
        emit,
        onSessionsChanged: (handler) => {
          boardChanged = handler;
          return unsubscribe;
        },
      },
    };
    const service = services[0];
    if (!service) {
      throw new Error("Browser service was not registered");
    }
    await serviceScope.run("browser-service-instance", async () => await service.start(context));
    const sessionEnd = on.mock.calls.find(([name]) => name === "session_end")?.[1];
    if (!sessionEnd) {
      throw new Error("Browser session_end hook was not registered");
    }
    const sessionContext = { agentId: "main", sessionId: "dashboard-proof", sessionKey };
    await stopBrowserDashboard(request);
    await sessionEnd({ ...sessionContext, reason: "reset" }, sessionContext);
    expect(getBrowserSessionTabStore().entries()).toHaveLength(1);
    const savedWidgets = fixture.widgets;
    fixture.widgets = [];
    await sessionEnd({ ...sessionContext, reason: "deleted" }, sessionContext);
    expect(getBrowserSessionTabStore().entries()).toEqual([]);
    fixture.widgets = savedWidgets;
    await stopBrowserDashboard(request);
    fixture.widgets = [];
    const store = getBrowserSessionTabStore();
    expect(store.entries()).toHaveLength(1);
    const entries = store.entries.bind(store);
    let discoveryRows = 0;
    const scans = vi.spyOn(store, "entries").mockImplementation(() => {
      const rows = entries();
      discoveryRows += rows.length;
      return rows;
    });
    try {
      boardChanged?.({ sessionKey, agentId: "main", reason: "board" });
    } finally {
      scans.mockRestore();
    }
    await vi.waitFor(() => expect(getBrowserSessionTabStore().entries()).toEqual([]));
    expect(browser.open).not.toHaveBeenCalled();
    fixture.widgets = savedWidgets;
    emit.mockClear();
    await requestBrowserDashboard(request);
    await requestBrowserDashboard(request);
    expect(await stopBrowserDashboard(request)).toMatchObject({ paused: true, stopping: false });
    await requestBrowserDashboard({ ...request, resume: true });
    expect(emit.mock.calls).toEqual(
      Array.from({ length: 4 }, () => [
        "dashboard_changed",
        { sessionKey, name: "service", instanceId: "instance-one" },
        { scope: "operator.admin" },
      ]),
    );
    browser.closeOwned.mockResolvedValueOnce({
      status: "unavailable",
      reason: "target-close-failed",
    });
    await expect(stopBrowserDashboard(request)).rejects.toThrow(/could not close/);
    expect(await inspectBrowserDashboard(request)).toMatchObject({ paused: true, stopping: true });
    emit.mockClear();
    await expect(sweepTrackedBrowserTabs({ ordinaryCleanup: false })).resolves.toBe(1);
    expect(await inspectBrowserDashboard(request)).toMatchObject({ paused: true, stopping: false });
    expect(emit.mock.calls).toEqual([
      [
        "dashboard_changed",
        { sessionKey, name: "service", instanceId: "instance-one" },
        { scope: "operator.admin" },
      ],
    ]);
    await requestBrowserDashboard({ ...request, resume: true });
    const started = createDeferred<void>();
    const finish = createDeferred<void>();
    let cleanupScope: string | undefined;
    browser.closeOwned.mockImplementationOnce(async () => {
      cleanupScope = serviceScope.getStore();
      started.resolve();
      await finish.promise;
      fixture.tabs = [];
      return { status: "closed" };
    });
    fixture.widgets = [];
    boardChanged?.({ sessionKey, agentId: "main", reason: "board" });
    await started.promise;
    let stopped = false;
    const stopping = Promise.resolve(service.stop?.(context)).then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    expect(unsubscribe).toHaveBeenCalledOnce();
    finish.resolve();
    await stopping;
    expect(cleanupScope).toBe("browser-service-instance");
    expect(readBrowserDashboardTabs()).toEqual([]);
    expect(fixture.tabs).toEqual([]);
    expect(discoveryRows).toBeLessThanOrEqual(1);
  });

  it.each(["removed", "replaced", "url-changed", "caller-aborted"] as const)(
    "compensates an open when %s races browser creation",
    async (kind) => {
      const started = createDeferred<void>();
      const finish = createDeferred<void>();
      browser.open.mockImplementationOnce(async () => {
        started.resolve();
        await finish.promise;
        return fixture.openedTab();
      });
      const controller = new AbortController();
      const pending = requestBrowserDashboard(request, { signal: controller.signal });
      const rejected = expect(pending).rejects.toThrow();
      await started.promise;
      if (kind === "removed") {
        fixture.widgets = [];
      }
      if (kind === "replaced") {
        fixture.widgets[0]!.instanceId = "instance-two";
      }
      if (kind === "url-changed") {
        fixture.widgets[0]!.props.url = "http://other.example/";
      }
      if (kind === "caller-aborted") {
        controller.abort(new Error("caller aborted"));
      }
      finish.resolve();
      await rejected;
      expect(fixture.tabs).toEqual([]);
      expect(readBrowserDashboardTabs()).toEqual([]);
      expect(browser.closeOwned).toHaveBeenCalledOnce();
    },
  );

  it("bounds retained-tab materialization while reconciling unrelated dashboard removals", async () => {
    const store = getBrowserSessionTabStore();
    const retained = [];
    for (let index = 0; index < 15; index++) {
      const record: BrowserSessionTabRecord = {
        version: 1,
        sessionKey,
        nativeTargetId: `seeded-${index}`,
        profile: "openclaw",
        profileFingerprint: "profile-one",
        browserInstanceFingerprint: "browser-one",
        interactionTargetKind: "native",
        trackedAt: 1000 + index,
        lastUsedAt: 2000 + index,
        ...(index < 5
          ? {
              dashboard: {
                sessionKey,
                agentId: "main",
                name: `removed-${index}`,
                instanceId: `instance-${index}`,
                url: "http://service.example/",
                state: "active" as const,
              },
            }
          : {}),
      };
      const key = browserSessionTabStorageKey(record);
      const clock = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000 + index);
      try {
        store.register(key, record);
      } finally {
        clock.mockRestore();
      }
      if (index >= 5) {
        retained.push({ key, value: record, createdAt: 1_700_000_000_000 + index });
      }
    }
    const entries = store.entries.bind(store);
    let fetchedRows = 0;
    const scans = vi.spyOn(store, "entries").mockImplementation(() => {
      const rows = entries();
      fetchedRows += rows.length;
      return rows;
    });
    try {
      expect(await reconcileBrowserDashboards()).toBe(5);
      expect(browser.closeOwned.mock.calls.map(([params]) => params.nativeTargetId)).toEqual(
        Array.from({ length: 5 }, (_, index) => `seeded-${index}`),
      );
      expect(fetchedRows).toBeLessThanOrEqual(30);
    } finally {
      scans.mockRestore();
    }
    expect(store.entries()).toEqual(retained);
  });

  it.each(["definition identity", "storage hash"] as const)(
    "refuses a retained dashboard whose %s changes during ownership lookup",
    async (change) => {
      await requestBrowserDashboard(request);
      const tab = readBrowserDashboardTabs()[0];
      if (!tab?.dashboard) {
        throw new Error("Expected the registered dashboard tab");
      }
      const { storageKey, ...record } = tab;
      browser.ownership.mockImplementationOnce(async () => {
        getBrowserSessionTabStore().register(
          storageKey,
          change === "storage hash"
            ? { ...record, profileFingerprint: "changed-profile" }
            : { ...record, dashboard: { ...tab.dashboard, name: "another-dashboard" } },
        );
        return {
          status: "durable",
          nativeTargetId: tab.nativeTargetId,
          profileFingerprint: tab.profileFingerprint,
          browserInstanceFingerprint: tab.browserInstanceFingerprint,
        };
      });
      await expect(requestBrowserDashboard(request)).rejects.toThrow(
        "Dashboard tab stopped during this operation",
      );
      expect(browser.open).toHaveBeenCalledOnce();
      expect(browser.closeOwned).not.toHaveBeenCalled();
    },
  );

  it.each(["selected", "unrelated"] as const)(
    "handles %s corrupt JSON introduced during the dashboard ownership lookup",
    async (scope) => {
      const opened = await requestBrowserDashboard(request);
      const tab = readBrowserDashboardTabs()[0];
      if (!tab) {
        throw new Error("Expected the registered dashboard tab");
      }
      const store = getBrowserSessionTabStore();
      store.register("unrelated-entry", { diagnostic: "unrelated" });
      browser.ownership.mockImplementationOnce(async () => {
        openOpenClawStateDatabase()
          .db.prepare(
            "UPDATE plugin_state_entries SET value_json = ? WHERE plugin_id = ? AND namespace = ? AND entry_key = ?",
          )
          .run(
            "{",
            "browser",
            "browser.session-tabs",
            scope === "selected" ? tab.storageKey : "unrelated-entry",
          );
        return {
          status: "durable",
          nativeTargetId: tab.nativeTargetId,
          profileFingerprint: tab.profileFingerprint,
          browserInstanceFingerprint: tab.browserInstanceFingerprint,
        };
      });
      if (scope === "selected") {
        await expect(requestBrowserDashboard(request)).rejects.toMatchObject({
          code: "PLUGIN_STATE_CORRUPT",
        });
      } else {
        expect((await requestBrowserDashboard(request)).browserTab).toEqual(opened.browserTab);
      }
      expect(() => readBrowserDashboardTabs()).toThrow("Plugin state entry contains corrupt JSON");
      expect(browser.open).toHaveBeenCalledOnce();
      expect(browser.closeOwned).not.toHaveBeenCalled();
    },
  );

  it("refuses a user browser profile before attaching or opening any tab", async () => {
    fixture.widgets[0]!.props.profile = "user";
    await expect(requestBrowserDashboard(request)).rejects.toThrow(
      /requires a local managed profile/,
    );
    expect(browser.open).not.toHaveBeenCalled();
    expect(browser.tabs).not.toHaveBeenCalled();
  });
});
