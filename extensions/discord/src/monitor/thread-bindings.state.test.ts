import { getSessionBindingService } from "openclaw/plugin-sdk/conversation-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type {
  OpenKeyedStoreOptions,
  PluginStateEntry,
  PluginStateKeyedStore,
  PluginStateSyncKeyedStore,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateKeyedStoreForTests,
  createPluginStateSyncKeyedStoreForTests,
  resetPluginStateStoreForTests,
  openOpenClawStateDatabase,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { withOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { discordPlugin } from "../channel.js";
import { EMPTY_DISCORD_TEST_CONFIG } from "../test-support/config.js";
import { registerThreadBindingCompatibilityTests } from "./thread-bindings.compatibility.test-support.js";
import { createThreadBindingManager, getThreadBindingManager } from "./thread-bindings.manager.js";
import { ensureBindingsLoaded, ensureBindingsLoadedAsync } from "./thread-bindings.state.js";
import { resetThreadBindingsForTests } from "./thread-bindings.test-support.js";
import type { ThreadBindingManager, ThreadBindingRecord } from "./thread-bindings.types.js";

type AsyncStore = Pick<
  PluginStateKeyedStore<ThreadBindingRecord>,
  "entries" | "register" | "delete"
>;
type SyncStore = Pick<
  PluginStateSyncKeyedStore<ThreadBindingRecord>,
  "entries" | "register" | "delete" | "update"
>;
const stores = vi.hoisted(() => ({
  warn: vi.fn(),
  entries: vi.fn<AsyncStore["entries"]>(),
  register: vi.fn<AsyncStore["register"]>(),
  delete: vi.fn<AsyncStore["delete"]>(),
  syncEntries: vi.fn<SyncStore["entries"]>(),
  syncRegister: vi.fn<SyncStore["register"]>(),
  syncDelete: vi.fn<SyncStore["delete"]>(),
  syncUpdate: vi.fn<NonNullable<SyncStore["update"]>>(),
  openKeyedStore: vi.fn<(options: OpenKeyedStoreOptions) => AsyncStore>(),
  openSyncKeyedStore: vi.fn<(options: OpenKeyedStoreOptions) => SyncStore>(),
}));

vi.mock("../runtime.js", () => {
  const runtime = { state: stores, logging: { getChildLogger: () => ({ warn: stores.warn }) } };
  return { getDiscordRuntime: () => runtime, getOptionalDiscordRuntime: () => runtime };
});

function persistedBinding(targetSessionKey = "agent:main:subagent:child") {
  const value: ThreadBindingRecord = {
    accountId: "work",
    channelId: "parent-1",
    threadId: "thread-1",
    targetKind: "subagent",
    targetSessionKey,
    agentId: "main",
    boundBy: "system",
    boundAt: 100,
    lastActivityAt: 100,
  };
  return { key: "work:thread-1", value, createdAt: 100 };
}

const replacementTarget = {
  threadId: "thread-1",
  channelId: "parent-1",
  targetKind: "subagent",
  targetSessionKey: "agent:main:subagent:replacement",
  agentId: "main",
  webhookId: "synthetic-webhook",
  webhookToken: "synthetic-token",
} satisfies Parameters<ThreadBindingManager["bindTarget"]>[0];

function createTestManager(options: { accountId?: string; persist?: boolean } = {}) {
  return createThreadBindingManager({
    accountId: "work",
    cfg: EMPTY_DISCORD_TEST_CONFIG,
    persist: false,
    enableSweeper: false,
    ...options,
  });
}

function installCanonicalRows(initial: Array<[string, ThreadBindingRecord]>) {
  const rows = new Map(initial);
  const entries = () => [...rows].map(([key, value]) => ({ key, value, createdAt: 100 }));
  stores.entries.mockImplementation(async () => entries());
  stores.syncEntries.mockImplementation(entries);
  stores.register.mockImplementation(async (key, value, options) => {
    options?.assertCurrent?.();
    rows.set(key, value);
  });
  stores.delete.mockImplementation(async (key, options) => {
    options?.assertCurrent?.();
    return rows.delete(key);
  });
  stores.syncRegister.mockImplementation((key, value) => {
    rows.set(key, value);
  });
  stores.syncDelete.mockImplementation((key) => rows.delete(key));
  stores.syncUpdate.mockImplementation((key, update) => {
    const next = update(rows.get(key));
    if (next === undefined) {
      return false;
    }
    rows.set(key, next);
    return true;
  });
  return rows;
}

async function persistentManager() {
  await ensureBindingsLoadedAsync();
  return await createTestManager({ persist: true });
}

function pauseNextWrite(rows?: Map<string, ThreadBindingRecord>) {
  const entered = createDeferred<void>();
  const finish = createDeferred<void>();
  stores.register.mockImplementationOnce(async (key, value, options) => {
    entered.resolve();
    await finish.promise;
    options?.assertCurrent?.();
    rows?.set(key, value);
  });
  return { entered, finish };
}

describe("Discord thread binding restoration", () => {
  beforeEach(async () => {
    await resetThreadBindingsForTests();
    for (const mock of Object.values(stores)) {
      mock.mockReset();
    }
    stores.entries.mockResolvedValue([]);
    stores.syncEntries.mockReturnValue([]);
    stores.syncDelete.mockReturnValue(true);
    stores.syncUpdate.mockReturnValue(false);
    stores.register.mockResolvedValue();
    stores.delete.mockResolvedValue(true);
    stores.openKeyedStore.mockImplementation(() => ({
      entries: stores.entries,
      register: stores.register,
      delete: stores.delete,
    }));
    stores.openSyncKeyedStore.mockImplementation(() => ({
      entries: stores.syncEntries,
      register: stores.syncRegister,
      delete: stores.syncDelete,
      update: stores.syncUpdate,
    }));
  });

  afterEach(async () => {
    await resetThreadBindingsForTests();
  });

  it("awaits one shared cold read before publishing channel binding managers", async () => {
    const ready = createDeferred<PluginStateEntry<ThreadBindingRecord>[]>();
    const entered = createDeferred<void>();
    stores.entries.mockImplementationOnce(() => {
      entered.resolve();
      return ready.promise;
    });
    stores.syncEntries.mockImplementation(() => {
      entered.resolve();
      return [];
    });
    const createManager = discordPlugin.conversationBindings!.createManager!;
    const first = Promise.resolve(
      createManager({ cfg: EMPTY_DISCORD_TEST_CONFIG, accountId: "work" }),
    );
    const second = Promise.resolve(
      createManager({ cfg: EMPTY_DISCORD_TEST_CONFIG, accountId: "other" }),
    );
    try {
      await entered.promise;
      expect(getThreadBindingManager("work")).toBeNull();
      expect(stores.openSyncKeyedStore).not.toHaveBeenCalled();
      expect(stores.entries).toHaveBeenCalledTimes(1);
    } finally {
      ready.resolve([persistedBinding()]);
      await Promise.all([first, second]);
    }
    expect(getThreadBindingManager("work")?.getByThreadId("thread-1")).toEqual(
      persistedBinding().value,
    );
    expect(getThreadBindingManager("other")?.listBindings()).toEqual([]);
    expect(stores.openSyncKeyedStore).not.toHaveBeenCalled();
  });

  it.each(["resolve", "reject"] as const)(
    "keeps newer synchronous initialization and activity when an older async read %ss",
    async (settlement) => {
      const ready = createDeferred<PluginStateEntry<ThreadBindingRecord>[]>();
      stores.entries.mockReturnValueOnce(ready.promise);
      const loading = ensureBindingsLoadedAsync();
      const current = persistedBinding("agent:main:subagent:replacement");
      let manager: ThreadBindingManager | undefined;
      try {
        stores.syncEntries.mockReturnValueOnce([current]);
        ensureBindingsLoaded();
        manager = await createTestManager();
        await manager.touchThread({ threadId: "thread-1", at: 200, persist: false });
        expect(manager.getByThreadId("thread-1")?.targetSessionKey).toBe(
          current.value.targetSessionKey,
        );
      } finally {
        if (settlement === "resolve") {
          ready.resolve([persistedBinding()]);
        } else {
          ready.reject(new Error("older read failed"));
        }
        await loading;
      }
      expect(manager?.getByThreadId("thread-1")).toEqual({ ...current.value, lastActivityAt: 200 });
    },
  );

  it("keeps bindings in memory after unavailable persistent startup", async () => {
    stores.entries.mockRejectedValueOnce(new Error("state unavailable"));
    const manager = await createTestManager({ persist: true });
    expect(manager).toBe(getThreadBindingManager("work"));
    const bindingManager = getThreadBindingManager("work")!;
    expect(bindingManager.listBindings()).toEqual([]);
    await bindingManager.bindTarget({
      ...replacementTarget,
      targetSessionKey: "agent:main:subagent:child",
    });
    expect(bindingManager.getByThreadId("thread-1")?.targetSessionKey).toBe(
      "agent:main:subagent:child",
    );
    expect(stores.openSyncKeyedStore).not.toHaveBeenCalled();
    await bindingManager.stop();
  });

  it("does not turn revoked bind authority into an in-memory fallback", async () => {
    stores.entries.mockResolvedValueOnce([persistedBinding()]);
    const manager = await persistentManager();
    const { entered, finish } = pauseNextWrite();
    let current = true;
    const binding = manager.bindTarget({
      ...replacementTarget,
      assertCurrent: () => {
        if (!current) {
          throw new Error("binding authority revoked");
        }
      },
    });
    const outcome = expect(binding).rejects.toThrow("binding authority revoked");
    await entered.promise;
    current = false;
    finish.resolve();
    await outcome;
    expect(manager.getByThreadId("thread-1")).toEqual(persistedBinding().value);
    await manager.stop();
  });

  it("retains the in-memory fallback after a failed write", async () => {
    stores.entries.mockResolvedValue([persistedBinding()]);
    const manager = await persistentManager();
    stores.register.mockRejectedValueOnce(new Error("persistence failed"));
    await manager.bindTarget(replacementTarget);
    expect(manager.getByThreadId("thread-1")?.targetSessionKey).toBe(
      replacementTarget.targetSessionKey,
    );
    expect(stores.register).toHaveBeenCalledOnce();
    expect(stores.openSyncKeyedStore).not.toHaveBeenCalled();
    await manager.stop();
  });

  registerThreadBindingCompatibilityTests({ stores, persistedBinding, persistentManager });

  it.each([false, true])("preflights selected stopping owners (matching=%s)", async (matching) => {
    const saved = persistedBinding();
    const other = persistedBinding(
      matching ? saved.value.targetSessionKey : "agent:other:subagent:child",
    );
    other.key = "other:thread-2";
    other.value.accountId = "other";
    other.value.threadId = "thread-2";
    const blocker = persistedBinding("agent:main:subagent:blocker");
    blocker.key = "work:thread-3";
    blocker.value.threadId = "thread-3";
    const rows = installCanonicalRows([
      [saved.key, saved.value],
      [other.key, other.value],
      [blocker.key, blocker.value],
    ]);
    const manager = await persistentManager();
    const otherManager = await createTestManager({ accountId: "other" });
    const { entered, finish } = pauseNextWrite(rows);
    const touching = manager.touchThread({ threadId: "thread-3", at: 200 });
    await entered.promise;
    const stopping = otherManager.stop();
    const setting = discordPlugin.conversationBindings!.setIdleTimeoutBySessionKeyAsync!({
      targetSessionKey: saved.value.targetSessionKey,
      idleTimeoutMs: 500,
    });
    const outcome = matching
      ? expect(setting).rejects.toThrow("stopping")
      : expect(setting).resolves.toHaveLength(1);
    try {
      finish.resolve();
      await Promise.all([touching, stopping, outcome]);
      expect(rows.get(saved.key)?.idleTimeoutMs).toBe(matching ? undefined : 500);
      expect(manager.getByThreadId("thread-1")?.idleTimeoutMs).toBe(matching ? undefined : 500);
      expect(rows.get(other.key)?.idleTimeoutMs).toBeUndefined();
    } finally {
      finish.resolve();
      await Promise.allSettled([touching, stopping, setting]);
      await manager.stop();
    }
  });

  it("keeps activity in memory after a real native read-only failure", async () => {
    await withOpenClawTestState({ label: "discord-binding-native-readonly" }, async () => {
      stores.openKeyedStore.mockImplementation((options) => {
        return createPluginStateKeyedStoreForTests<ThreadBindingRecord>("discord", options);
      });
      let observed = false;
      stores.openSyncKeyedStore.mockImplementation((options) => {
        const store = createPluginStateSyncKeyedStoreForTests<ThreadBindingRecord>(
          "discord",
          options,
        );
        return {
          ...store,
          update: (...args: Parameters<NonNullable<typeof store.update>>) => {
            const [key, update, updateOptions] = args;
            if (!store.update) {
              throw new Error("missing native atomic update");
            }
            return store.update(
              key,
              (current) => {
                observed = true;
                return update(current);
              },
              updateOptions,
            );
          },
        };
      });
      const saved = persistedBinding();
      const store = createPluginStateSyncKeyedStoreForTests<ThreadBindingRecord>("discord", {
        namespace: "thread-bindings",
        maxEntries: 10_000,
      });
      store.register(saved.key, saved.value);
      const manager = await persistentManager();
      const database = openOpenClawStateDatabase();
      try {
        database.db.exec("PRAGMA query_only = ON");
        getSessionBindingService().touch(saved.key, 200, {
          channel: "discord",
          accountId: "work",
        });
        expect(observed).toBe(false);
        expect(manager.getByThreadId("thread-1")?.lastActivityAt).toBe(200);
      } finally {
        database.db.exec("PRAGMA query_only = OFF");
        await manager.stop();
      }
      expect(manager.getByThreadId("thread-1")?.targetSessionKey).toBe(
        saved.value.targetSessionKey,
      );
      expect(store.lookup(saved.key)?.targetSessionKey).toBe(
        manager.getByThreadId("thread-1")?.targetSessionKey,
      );
      await resetThreadBindingsForTests();
      resetPluginStateStoreForTests();
    });
  });

  it("keeps generic synchronous lifecycle setters synchronous", async () => {
    stores.entries.mockResolvedValueOnce([persistedBinding()]);
    const manager = await persistentManager();
    let saved = persistedBinding().value;
    stores.syncUpdate.mockImplementation((_key, update) => {
      saved = update(saved) ?? saved;
      return true;
    });
    const support = discordPlugin.conversationBindings!;
    const idle = support.setIdleTimeoutBySessionKey!({
      targetSessionKey: saved.targetSessionKey,
      accountId: "work",
      idleTimeoutMs: 500,
    });
    expect(Array.isArray(idle)).toBe(true);
    expect(saved.idleTimeoutMs).toBe(500);
    const age = support.setMaxAgeBySessionKey!({
      targetSessionKey: saved.targetSessionKey,
      accountId: "work",
      maxAgeMs: 1000,
    });
    expect(Array.isArray(age)).toBe(true);
    expect(saved.maxAgeMs).toBe(1000);
    expect(stores.register).not.toHaveBeenCalled();
    await manager.stop();
  });
});
