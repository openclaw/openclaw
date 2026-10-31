import assert from "node:assert/strict";
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
import { setRuntimeConfigSnapshot } from "openclaw/plugin-sdk/runtime-config-snapshot";
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

it.each(["stop", "replacement"] as const)("keeps cleanup service-scoped until %s", async (end) => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    setRuntimeConfigSnapshot({});
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    // Native timers retain async context; keep that contract in the fake clock.
    const schedule = globalThis.setTimeout;
    vi.spyOn(globalThis, "setTimeout").mockImplementation((callback, delay, ...args) =>
      schedule(AsyncLocalStorage.bind(callback), delay, ...args),
    );
    const lifecycle = await registerDiscovery(state.stateDir);
    const observed = observeReconciliation();
    await lifecycle.start();
    const runtime = await serviceScope.run("ended-caller", () =>
      createBrowserRuntimeState({
        resolved: resolveBrowserConfig(undefined),
        port: 18_791,
      }),
    );
    try {
      await vi.advanceTimersByTimeAsync(300_000);
      await observed.entered;
      if (end === "stop") {
        await lifecycle.stop();
      } else {
        setBrowserStateRuntime({ ...getBrowserStateRuntime() });
      }
      await vi.advanceTimersByTimeAsync(600_000);
      expect(observed.scopes).toEqual(["discovery-service"]);
    } finally {
      await lifecycle.stop();
      await stopBrowserRuntime({ current: runtime, clearState: vi.fn(), onWarn: vi.fn() });
      vi.useRealTimers();
    }
  });
});

function observeReconciliation(result = Promise.resolve(0)) {
  const entered = createDeferred<void>();
  const scopes: Array<string | undefined> = [];
  reconcile.mockImplementation(async () => {
    scopes.push(serviceScope.getStore());
    entered.resolve();
    return result;
  });
  return { entered: entered.promise, scopes };
}

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
  const openKeyedStore = (options: OpenKeyedStoreOptions) =>
    options.namespace === "browser.session-tabs"
      ? store
      : createPluginStateKeyedStoreForTests("browser", options);
  registerBrowserPlugin(
    createTestPluginApi({
      id: "browser",
      on: hooks,
      runtime: { state: { openKeyedStore } } as unknown as PluginRuntime,
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
  assert(service?.stop && sessionEnd, "Browser discovery lifecycle was not registered");
  const subscribe = vi.fn<OpenClawPluginGatewayEvents["onSessionsChanged"]>(() => vi.fn());
  const scheduler = createTestPluginServiceScheduler();
  onTestFinished(() => scheduler.stop());
  const context: OpenClawPluginServiceContextV2 = {
    scheduler,
    config: {},
    stateDir,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    gatewayEvents: { emit: vi.fn(), onSessionsChanged: subscribe },
  };
  return {
    replace: () => registerDiscovery(stateDir),
    entries,
    subscribe,
    start: () => serviceScope.run("discovery-service", () => service.start(context)),
    stop: () => service.stop?.(context),
    boardChanged: () =>
      subscribe.mock.lastCall?.[0]({ sessionKey: "discovery", agentId: "main", reason: "board" }),
    sessionEnd: () => sessionEnd({ sessionKey, reason: "deleted" }, { sessionKey }),
  };
}

function withDiscovery<T extends unknown[]>(
  run: (lifecycle: Awaited<ReturnType<typeof registerDiscovery>>, ...args: T) => Promise<void>,
) {
  return (...args: T) =>
    withOpenClawTestState({ scenario: "minimal" }, async ({ stateDir }) => {
      const lifecycle = await registerDiscovery(stateDir);
      await lifecycle.start();
      try {
        await run(lifecycle, ...args);
      } finally {
        await lifecycle.stop();
      }
    });
}

function holdStoreReply(storageKey: string, action: "set" | "delete") {
  const binding = vi.mocked(getBrowserStateRuntime().sessionTabs.withCurrent!);
  const bindStore = binding.getMockImplementation();
  assert(bindStore, "Expected the registered real-store fixture binding");
  const applied = createDeferred<void>();
  const release = createDeferred<void>();
  binding.mockImplementation((authority) => {
    const store = bindStore(authority);
    return {
      ...store,
      compareAndApply: async (key, comparison, intent) => {
        const result = await store.compareAndApply(key, comparison, intent);
        if (key === storageKey && intent.action === action && result.status === "applied") {
          applied.resolve();
          await release.promise;
        }
        return result;
      },
    };
  });
  return { applied, release, restore: () => binding.mockImplementation(bindStore) };
}

function tabOptions(targetId: string) {
  return {
    sessionKey,
    targetId,
    profile: "openclaw",
    ownership: {
      status: "durable" as const,
      nativeTargetId: targetId,
      profileFingerprint: "shutdown-profile",
      browserInstanceFingerprint: "shutdown-browser",
    },
  };
}

async function holdDiscovery(lifecycle: Awaited<ReturnType<typeof registerDiscovery>>) {
  const rows = await getBrowserSessionTabStore().entries();
  lifecycle.entries.mockClear();
  const pending = createDeferred<typeof rows>();
  lifecycle.entries.mockReturnValueOnce(pending.promise);
  return () => pending.resolve(rows);
}

it.each([
  ["board", false],
  ["session end", false],
  ["board", true],
  ["session end", true],
] as const)(
  "discovers %s owners with replaced runtime=%s without host SQL",
  withDiscovery(async (lifecycle, trigger: "board" | "session end", replaced: boolean) => {
    const releaseDiscovery = replaced ? await holdDiscovery(lifecycle) : () => {};
    const db = openOpenClawStateDatabase().db;
    const prepare = db.prepare.bind(db);
    const hostRead = vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
      if (/select\b[\s\S]*\bplugin_state_entries\b/i.test(sql)) {
        throw new Error("Dashboard discovery queried plugin rows on the host");
      }
      return prepare(sql);
    });
    try {
      const pending = trigger === "board" ? lifecycle.boardChanged() : lifecycle.sessionEnd();
      if (replaced) {
        expect(lifecycle.entries).toHaveBeenCalledOnce();
        await lifecycle.replace();
        releaseDiscovery();
      }
      await pending;
      await lifecycle.stop();
      expect(lifecycle.entries).toHaveBeenCalledOnce();
      if (replaced) {
        lifecycle.boardChanged();
        await lifecycle.sessionEnd();
        expect(lifecycle.entries).toHaveBeenCalledOnce();
        expect(reconcile).not.toHaveBeenCalled();
      } else {
        expect(reconcile).toHaveBeenCalledExactlyOnceWith({
          sessionKeys: [sessionKey],
          onWarn: expect.any(Function),
        });
      }
    } finally {
      releaseDiscovery();
      hostRead.mockRestore();
    }
  }),
);

it.each(["stop", "restart"] as const)(
  "joins service-scoped discovery on %s",
  withDiscovery(async (lifecycle, transition: "stop" | "restart") => {
    const releaseDiscovery = await holdDiscovery(lifecycle);
    const finishing = createDeferred<number>();
    const observed = observeReconciliation(finishing.promise);
    let stopping: Promise<void> | undefined;
    try {
      lifecycle.boardChanged();
      expect(lifecycle.entries).toHaveBeenCalledOnce();
      const settled = vi.fn();
      stopping = Promise.resolve(transition === "stop" ? lifecycle.stop() : lifecycle.start()).then(
        settled,
      );
      lifecycle.boardChanged();
      await Promise.resolve();
      expect(settled).not.toHaveBeenCalled();
      expect(reconcile).not.toHaveBeenCalled();
      releaseDiscovery();
      await observed.entered;
      expect(settled).not.toHaveBeenCalled();
      finishing.resolve(0);
      await stopping;
      expect(observed.scopes).toEqual(["discovery-service"]);
      expect(lifecycle.subscribe).toHaveBeenCalledTimes(transition === "stop" ? 1 : 2);
      await lifecycle.stop();
      lifecycle.boardChanged();
      expect(lifecycle.entries).toHaveBeenCalledOnce();
    } finally {
      releaseDiscovery();
      finishing.resolve(0);
      await stopping;
    }
  }),
);

it.each(["registration", "retirement"] as const)(
  "joins %s during shutdown",
  withDiscovery(async (lifecycle, phase: "registration" | "retirement") => {
    const options = tabOptions(phase === "registration" ? "shutdown-tab" : "shutdown-close");
    const storageKey = browserSessionTabStorageKey({ ...options.ownership, sessionKey });
    if (phase === "retirement") {
      assert(await trackSessionBrowserTab(options), "Expected a durable cleanup row");
    }
    const reply = holdStoreReply(storageKey, phase === "registration" ? "set" : "delete");
    const dispatched = createDeferred<void>();
    const releaseClose = createDeferred<void>();
    const operation =
      phase === "registration"
        ? trackSessionBrowserTab({ ...options, now: 1_000 })
        : closeTrackedBrowserTabsForSessions({
            sessionKeys: [sessionKey],
            closeTab: async () => {
              dispatched.resolve();
              await releaseClose.promise;
            },
          });
    let stopping: Promise<void> | undefined;
    try {
      await Promise.race([
        phase === "registration" ? reply.applied.promise : dispatched.promise,
        operation.then(() => {
          throw new Error("Tab operation settled before its held reply");
        }),
      ]);
      const settled = vi.fn();
      stopping = Promise.resolve(lifecycle.stop()).then(settled);
      const persisted = await getBrowserSessionTabStore().lookup(storageKey);
      expect(persisted).toMatchObject(
        phase === "registration"
          ? {
              sessionKey,
              nativeTargetId: "shutdown-tab",
              profile: "openclaw",
              lastUsedAt: 1_000,
            }
          : { cleanupKind: "lifecycle" },
      );
      expect(settled).not.toHaveBeenCalled();
      if (phase === "retirement") {
        releaseClose.resolve();
        await reply.applied.promise;
        expect(settled).not.toHaveBeenCalled();
      }
      reply.release.resolve();
      const result = await operation;
      if (phase === "retirement") {
        expect(result).toBe(1);
      }
      await stopping;
      expect(await getBrowserSessionTabStore().lookup(storageKey)).toEqual(
        phase === "registration" ? persisted : undefined,
      );
    } finally {
      releaseClose.resolve();
      reply.release.resolve();
      await Promise.allSettled([operation, stopping]);
      reply.restore();
    }
  }),
);
