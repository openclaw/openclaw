import { AsyncLocalStorage } from "node:async_hooks";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type {
  OpenClawPluginGatewayEvents,
  OpenClawPluginService,
  OpenClawPluginServiceContext,
} from "openclaw/plugin-sdk/plugin-entry";
import type { OpenKeyedStoreOptions } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateKeyedStoreForTests,
  createPluginStateSyncKeyedStoreForTests,
  openOpenClawStateDatabase,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import type { PluginRuntime } from "openclaw/plugin-sdk/runtime-store";
import { withOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { registerBrowserPlugin } from "./plugin-registration.js";
import { persistBrowserDashboardStopIntent } from "./src/browser/session-tab-store.js";

const reconcile = vi.hoisted(() => vi.fn(async () => 0));
vi.mock("./src/browser-dashboard.js", () => ({ reconcileBrowserDashboards: reconcile }));
vi.mock("./register.runtime.js", () => {
  throw new Error("Dashboard discovery must not load browser control");
});

const sessionKey = "agent:main:discovery";
const serviceScope = new AsyncLocalStorage<string>();

beforeEach(() => reconcile.mockReset());
afterEach(() => vi.restoreAllMocks());

function registerDiscovery(stateDir: string) {
  const services: OpenClawPluginService[] = [];
  const hooks = vi.fn();
  const store = createPluginStateKeyedStoreForTests<unknown>("browser", {
    namespace: "browser.session-tabs",
    maxEntries: 5_000,
    overflowPolicy: "reject-new",
  });
  const entries = vi.spyOn(store, "entries");
  registerBrowserPlugin(
    createTestPluginApi({
      id: "browser",
      name: "Browser",
      source: "test",
      rootDir: stateDir,
      config: {},
      on: hooks,
      runtime: {
        state: {
          openSyncKeyedStore: (options: OpenKeyedStoreOptions) =>
            createPluginStateSyncKeyedStoreForTests("browser", options),
          openKeyedStore: (options: OpenKeyedStoreOptions) =>
            options.namespace === "browser.session-tabs"
              ? store
              : createPluginStateKeyedStoreForTests("browser", options),
        },
      } as unknown as PluginRuntime,
      registerService: (service) => services.push(service),
    }),
  );
  persistBrowserDashboardStopIntent({
    sessionKey,
    agentId: "main",
    name: "service",
    instanceId: "instance-one",
    url: "https://service.example/",
    profile: "openclaw",
  });
  const service = services[0];
  const sessionEnd = hooks.mock.calls.find(([name]) => name === "session_end")?.[1];
  if (!service?.stop || !sessionEnd) {
    throw new Error("Browser discovery lifecycle was not registered");
  }
  let onBoardChanged: Parameters<OpenClawPluginGatewayEvents["onSessionsChanged"]>[0] | undefined;
  const subscribe = vi.fn<OpenClawPluginGatewayEvents["onSessionsChanged"]>((handler) => {
    onBoardChanged = handler;
    return vi.fn();
  });
  const context: OpenClawPluginServiceContext = {
    config: {},
    stateDir,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    gatewayEvents: {
      emit: vi.fn(),
      onSessionsChanged: subscribe,
    },
  };
  return {
    entries,
    subscribe,
    async start() {
      await serviceScope.run("discovery-service", () => service.start(context));
    },
    stop: () => service.stop?.(context),
    boardChanged: () =>
      onBoardChanged?.({ sessionKey: "discovery", agentId: "main", reason: "board" }),
    sessionEnd: () => sessionEnd({ sessionKey, reason: "deleted" }, { sessionKey }),
  };
}

it.each(["board", "session end"] as const)(
  "discovers %s dashboard owners without querying plugin rows on the host",
  async (trigger) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const lifecycle = registerDiscovery(state.stateDir);
      await lifecycle.start();
      const db = openOpenClawStateDatabase().db;
      const prepare = db.prepare.bind(db);
      const hostRead = vi.spyOn(db, "prepare").mockImplementation((sql) => {
        if (/select\b[\s\S]*\bplugin_state_entries\b/i.test(sql)) {
          throw new Error("Dashboard discovery queried plugin rows on the host");
        }
        return prepare(sql);
      });
      try {
        if (trigger === "board") {
          lifecycle.boardChanged();
          await lifecycle.stop();
        } else {
          await lifecycle.sessionEnd();
        }
        expect(lifecycle.entries).toHaveBeenCalledOnce();
        expect(reconcile).toHaveBeenCalledExactlyOnceWith({
          sessionKeys: [sessionKey],
          onWarn: expect.any(Function),
        });
      } finally {
        hostRead.mockRestore();
        await lifecycle.stop();
      }
    });
  },
);

it.each(["stop", "restart"] as const)(
  "joins deferred discovery and reconciliation during %s, retaining the service context",
  async (transition) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const lifecycle = registerDiscovery(state.stateDir);
      await lifecycle.start();
      const rows = await lifecycle.entries();
      lifecycle.entries.mockClear();
      const discovery = createDeferred<typeof rows>();
      const finishing = createDeferred<number>();
      lifecycle.entries.mockReturnValueOnce(discovery.promise);
      let observedScope: string | undefined;
      reconcile.mockImplementationOnce(async () => {
        observedScope = serviceScope.getStore();
        return await finishing.promise;
      });
      let stopping: Promise<void> | undefined;
      try {
        lifecycle.boardChanged();
        expect(lifecycle.entries).toHaveBeenCalledOnce();
        let stopped = false;
        stopping = Promise.resolve(
          transition === "stop" ? lifecycle.stop() : lifecycle.start(),
        ).then(() => {
          stopped = true;
        });
        expect(lifecycle.subscribe).toHaveBeenCalledOnce();
        lifecycle.boardChanged();
        await Promise.resolve();
        expect(stopped).toBe(false);
        expect(reconcile).not.toHaveBeenCalled();
        discovery.resolve(rows);
        await vi.waitFor(() => expect(reconcile).toHaveBeenCalledOnce());
        expect(stopped).toBe(false);
        finishing.resolve(0);
        await stopping;
        expect(observedScope).toBe("discovery-service");
        expect(lifecycle.entries).toHaveBeenCalledOnce();
        expect(lifecycle.subscribe).toHaveBeenCalledTimes(transition === "stop" ? 1 : 2);
        await lifecycle.stop();
        lifecycle.boardChanged();
        expect(lifecycle.entries).toHaveBeenCalledOnce();
      } finally {
        discovery.resolve(rows);
        finishing.resolve(0);
        await stopping;
        await lifecycle.stop();
      }
    });
  },
);

it.each(["board", "session end"] as const)(
  "discards %s discovery after its Browser runtime is replaced",
  async (trigger) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const lifecycle = registerDiscovery(state.stateDir);
      await lifecycle.start();
      const rows = await lifecycle.entries();
      lifecycle.entries.mockClear();
      const discovery = createDeferred<typeof rows>();
      lifecycle.entries.mockReturnValueOnce(discovery.promise);
      const pending = trigger === "board" ? lifecycle.boardChanged() : lifecycle.sessionEnd();
      expect(lifecycle.entries).toHaveBeenCalledOnce();
      registerDiscovery(state.stateDir);
      discovery.resolve(rows);
      await pending;
      await lifecycle.stop();
      expect(reconcile).not.toHaveBeenCalled();
      lifecycle.boardChanged();
      await lifecycle.sessionEnd();
      expect(lifecycle.entries).toHaveBeenCalledOnce();
      expect(reconcile).not.toHaveBeenCalled();
    });
  },
);
