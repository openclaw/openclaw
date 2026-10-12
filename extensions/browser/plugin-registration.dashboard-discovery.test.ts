import { AsyncLocalStorage } from "node:async_hooks";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type {
  OpenClawPluginGatewayEvents,
  OpenClawPluginApi,
  OpenClawPluginServiceContextV2,
} from "openclaw/plugin-sdk/plugin-entry";
import type {
  OpenKeyedStoreOptions,
  PluginStateKeyedStore,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateKeyedStoreForTests,
  openOpenClawStateDatabase,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import {
  createTestPluginApi,
  createTestPluginServiceScheduler,
} from "openclaw/plugin-sdk/plugin-test-api";
import type { PluginRuntime } from "openclaw/plugin-sdk/runtime-store";
import { withOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { registerBrowserPlugin } from "./plugin-registration.js";
import { getBrowserStateRuntime, setBrowserStateRuntime } from "./src/browser-runtime-state.js";
import { resolveBrowserConfig } from "./src/browser/config.js";
import { createBrowserRuntimeState, stopBrowserRuntime } from "./src/browser/runtime-lifecycle.js";
import { browserSessionTabStorageKey } from "./src/browser/session-tab-identity.js";
import {
  closeTrackedBrowserTabsForSessions,
  trackSessionBrowserTab,
} from "./src/browser/session-tab-registry.js";
import {
  getBrowserSessionTabStore,
  persistBrowserDashboardStopIntent,
} from "./src/browser/session-tab-store.js";

const reconcile = vi.hoisted(() => vi.fn(async () => 0));
vi.mock("./src/browser-dashboard.js", () => ({ reconcileBrowserDashboards: reconcile }));
vi.mock("./register.runtime.js", () => {
  throw new Error("Dashboard discovery must not load browser control");
});

const sessionKey = "agent:main:discovery";
const serviceScope = new AsyncLocalStorage<string>();

beforeEach(() => reconcile.mockReset());
afterEach(() => vi.restoreAllMocks());

it.each(["stop", "replacement"] as const)(
  "runs cleanup under service authority until %s",
  async (end) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      // Native timers retain async context; keep that contract in the fake clock.
      const schedule = globalThis.setTimeout;
      vi.spyOn(globalThis, "setTimeout").mockImplementation((callback, delay, ...args) =>
        schedule(AsyncLocalStorage.bind(callback), delay, ...args),
      );
      const lifecycle = await registerDiscovery(state.stateDir);
      const observed = createDeferred<void>();
      const scopes: Array<string | undefined> = [];
      reconcile.mockImplementation(async () => {
        scopes.push(serviceScope.getStore());
        observed.resolve();
        return 0;
      });
      await lifecycle.start();
      const runtime = await serviceScope.run("ended-caller", () =>
        createBrowserRuntimeState({
          resolved: resolveBrowserConfig(undefined),
          port: 18_791,
        }),
      );
      try {
        await vi.advanceTimersByTimeAsync(300_000);
        await observed.promise;
        expect(scopes).toEqual(["discovery-service"]);
        if (end === "stop") {
          await lifecycle.stop();
        } else {
          setBrowserStateRuntime({ ...getBrowserStateRuntime() });
        }
        await vi.advanceTimersByTimeAsync(600_000);
        expect(scopes).toHaveLength(1);
      } finally {
        await lifecycle.stop();
        await stopBrowserRuntime({
          current: runtime,
          clearState: vi.fn(),
          onWarn: vi.fn(),
        });
        vi.useRealTimers();
      }
    });
  },
);

async function registerDiscovery(stateDir: string) {
  const services: Parameters<OpenClawPluginApi["registerService"]>[0][] = [];
  const hooks = vi.fn();
  const store = createPluginStateKeyedStoreForTests<unknown>("browser", {
    namespace: "browser.session-tabs",
    maxEntries: 5_000,
    overflowPolicy: "reject-new",
  });
  const entries = vi.fn(async (bound: PluginStateKeyedStore<unknown, 2>) => await bound.entries());
  const withCurrent = store.withCurrent!;
  vi.spyOn(store, "withCurrent").mockImplementation((authority) => {
    const bound = withCurrent(authority);
    return { ...bound, entries: () => entries(bound) };
  });
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
          openKeyedStore: (options: OpenKeyedStoreOptions) =>
            options.namespace === "browser.session-tabs"
              ? store
              : createPluginStateKeyedStoreForTests("browser", options),
        },
      } as unknown as PluginRuntime,
      registerService: (service) => services.push(service),
    }),
  );
  await persistBrowserDashboardStopIntent({
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
  const scheduler = createTestPluginServiceScheduler();
  onTestFinished(() => scheduler.stop());
  const context: OpenClawPluginServiceContextV2 = {
    scheduler,
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
      const lifecycle = await registerDiscovery(state.stateDir);
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
      const lifecycle = await registerDiscovery(state.stateDir);
      await lifecycle.start();
      const rows = await getBrowserSessionTabStore().entries();
      lifecycle.entries.mockClear();
      const discovery = createDeferred<typeof rows>();
      const finishing = createDeferred<number>();
      const reconciling = createDeferred<void>();
      lifecycle.entries.mockReturnValueOnce(discovery.promise);
      let observedScope: string | undefined;
      reconcile.mockImplementationOnce(async () => {
        observedScope = serviceScope.getStore();
        reconciling.resolve();
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
        await reconciling.promise;
        expect(reconcile).toHaveBeenCalledOnce();
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
      const lifecycle = await registerDiscovery(state.stateDir);
      await lifecycle.start();
      const rows = await getBrowserSessionTabStore().entries();
      lifecycle.entries.mockClear();
      const discovery = createDeferred<typeof rows>();
      lifecycle.entries.mockReturnValueOnce(discovery.promise);
      const pending = trigger === "board" ? lifecycle.boardChanged() : lifecycle.sessionEnd();
      expect(lifecycle.entries).toHaveBeenCalledOnce();
      await registerDiscovery(state.stateDir);
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

it("joins an accepted tab registration reply during service shutdown", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const lifecycle = await registerDiscovery(state.stateDir);
    await lifecycle.start();
    const binding = vi.mocked(getBrowserStateRuntime().sessionTabs.withCurrent!);
    const bindStore = binding.getMockImplementation();
    if (!bindStore) {
      throw new Error("Expected the registered real-store fixture binding");
    }
    const applied = createDeferred<void>();
    const releaseReply = createDeferred<void>();
    const ownership = {
      status: "durable" as const,
      nativeTargetId: "shutdown-tab",
      profileFingerprint: "shutdown-profile",
      browserInstanceFingerprint: "shutdown-browser",
    };
    const storageKey = browserSessionTabStorageKey({ ...ownership, sessionKey });
    binding.mockImplementation((authority) => {
      const boundStore = bindStore(authority);
      return {
        ...boundStore,
        compareAndApply: async (key, comparison, intent) => {
          const result = await boundStore.compareAndApply(key, comparison, intent);
          if (key === storageKey && intent.action === "set" && result.status === "applied") {
            applied.resolve();
            await releaseReply.promise;
          }
          return result;
        },
      };
    });
    const tracking = trackSessionBrowserTab({
      sessionKey,
      targetId: ownership.nativeTargetId,
      profile: "openclaw",
      ownership,
      now: 1_000,
    });
    let stopping: Promise<void> | undefined;
    try {
      await Promise.race([
        applied.promise,
        tracking.then(() => {
          throw new Error("Tab registration settled without holding its applied reply");
        }),
      ]);
      let stopped = false;
      stopping = Promise.resolve(lifecycle.stop()).then(() => {
        stopped = true;
      });
      const persisted = await getBrowserSessionTabStore().lookup(storageKey);
      expect(persisted).toMatchObject({
        sessionKey,
        nativeTargetId: ownership.nativeTargetId,
        profile: "openclaw",
        lastUsedAt: 1_000,
      });
      expect(stopped).toBe(false);
      releaseReply.resolve();
      await Promise.all([tracking, stopping]);
      expect(stopped).toBe(true);
      expect(await getBrowserSessionTabStore().lookup(storageKey)).toEqual(persisted);
    } finally {
      releaseReply.resolve();
      await Promise.allSettled([tracking, stopping]);
      binding.mockImplementation(bindStore);
      await lifecycle.stop();
    }
  });
});

it("joins a cold lifecycle close and its retirement reply during service shutdown", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const lifecycle = await registerDiscovery(state.stateDir);
    await lifecycle.start();
    const tab = await trackSessionBrowserTab({
      sessionKey,
      targetId: "shutdown-close",
      profile: "openclaw",
      ownership: {
        status: "durable",
        nativeTargetId: "shutdown-close",
        profileFingerprint: "shutdown-profile",
        browserInstanceFingerprint: "shutdown-browser",
      },
    });
    if (!tab) {
      throw new Error("Expected a durable cleanup row");
    }
    const binding = vi.mocked(getBrowserStateRuntime().sessionTabs.withCurrent!);
    const bindStore = binding.getMockImplementation()!;
    const dispatched = createDeferred<void>();
    const releaseClose = createDeferred<void>();
    const retired = createDeferred<void>();
    const releaseRetirement = createDeferred<void>();
    binding.mockImplementation((authority) => {
      const store = bindStore(authority);
      return {
        ...store,
        compareAndApply: async (key, comparison, intent) => {
          const result = await store.compareAndApply(key, comparison, intent);
          if (key === tab.storageKey && intent.action === "delete" && result.status === "applied") {
            retired.resolve();
            await releaseRetirement.promise;
          }
          return result;
        },
      };
    });
    const closing = closeTrackedBrowserTabsForSessions({
      sessionKeys: [sessionKey],
      closeTab: async () => {
        dispatched.resolve();
        await releaseClose.promise;
      },
    });
    let stopping: Promise<void> | undefined;
    try {
      await dispatched.promise;
      let stopped = false;
      stopping = Promise.resolve(lifecycle.stop()).then(() => {
        stopped = true;
      });
      expect(await getBrowserSessionTabStore().lookup(tab.storageKey)).toMatchObject({
        cleanupKind: "lifecycle",
      });
      expect(stopped).toBe(false);
      releaseClose.resolve();
      await retired.promise;
      expect(stopped).toBe(false);
      releaseRetirement.resolve();
      expect(await closing).toBe(1);
      await stopping;
      expect(await getBrowserSessionTabStore().lookup(tab.storageKey)).toBeUndefined();
    } finally {
      releaseClose.resolve();
      releaseRetirement.resolve();
      await Promise.allSettled([closing, stopping]);
      binding.mockImplementation(bindStore);
      await lifecycle.stop();
    }
  });
});
