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
import { unbindThreadBindingsBySessionKey } from "./thread-bindings.lifecycle.js";
import { createThreadBindingManager, getThreadBindingManager } from "./thread-bindings.manager.js";
import { ensureBindingsLoaded, ensureBindingsLoadedAsync } from "./thread-bindings.state.js";
import { resetThreadBindingsForTests } from "./thread-bindings.test-support.js";
import type { ThreadBindingRecord } from "./thread-bindings.types.js";

const stores = vi.hoisted(() => {
  const entries = vi.fn<() => Promise<PluginStateEntry<ThreadBindingRecord>[]>>();
  const register = vi.fn<PluginStateKeyedStore<ThreadBindingRecord>["register"]>();
  const remove = vi.fn<PluginStateKeyedStore<ThreadBindingRecord>["delete"]>();
  const syncRegister = vi.fn<PluginStateSyncKeyedStore<ThreadBindingRecord>["register"]>();
  const syncUpdate = vi.fn<NonNullable<PluginStateSyncKeyedStore<ThreadBindingRecord>["update"]>>();
  const syncDeleteIf =
    vi.fn<NonNullable<PluginStateSyncKeyedStore<ThreadBindingRecord>["deleteIf"]>>();
  const syncDelete = vi.fn<PluginStateSyncKeyedStore<ThreadBindingRecord>["delete"]>();
  const syncEntries = vi.fn<() => PluginStateEntry<ThreadBindingRecord>[]>();
  return {
    warn: vi.fn(),
    entries,
    register,
    delete: remove,
    syncEntries,
    syncRegister,
    syncDelete,
    syncUpdate,
    syncDeleteIf,
    openKeyedStore: vi.fn(
      (
        _options: OpenKeyedStoreOptions,
      ): Pick<PluginStateKeyedStore<ThreadBindingRecord>, "entries" | "register" | "delete"> => ({
        entries,
        register,
        delete: remove,
      }),
    ),
    openSyncKeyedStore: vi.fn(
      (
        _options: OpenKeyedStoreOptions,
      ): Pick<
        PluginStateSyncKeyedStore<ThreadBindingRecord>,
        "entries" | "register" | "delete" | "update" | "deleteIf"
      > => ({
        entries: syncEntries,
        register: syncRegister,
        delete: syncDelete,
        update: syncUpdate,
        deleteIf: syncDeleteIf,
      }),
    ),
  };
});

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

function compatibilityManager() {
  return createThreadBindingManager({
    accountId: "work",
    cfg: EMPTY_DISCORD_TEST_CONFIG,
    persist: false,
    enableSweeper: false,
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
  stores.syncDeleteIf.mockImplementation((key, predicate) => {
    const current = rows.get(key);
    return current && predicate(current) ? rows.delete(key) : false;
  });
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
  return await createThreadBindingManager({
    accountId: "work",
    cfg: EMPTY_DISCORD_TEST_CONFIG,
    persist: true,
    enableSweeper: false,
  });
}

describe("Discord thread binding restoration", () => {
  beforeEach(async () => {
    await resetThreadBindingsForTests();
    stores.warn.mockReset();
    stores.entries.mockReset().mockResolvedValue([]);
    stores.syncEntries.mockReset().mockReturnValue([]);
    stores.syncRegister.mockReset();
    stores.syncDelete.mockReset().mockReturnValue(true);
    stores.syncUpdate.mockReset().mockReturnValue(false);
    stores.syncDeleteIf.mockReset().mockReturnValue(false);
    stores.register.mockReset().mockResolvedValue();
    stores.delete.mockReset().mockResolvedValue(true);
    stores.openKeyedStore.mockReset().mockImplementation(() => ({
      entries: stores.entries,
      register: stores.register,
      delete: stores.delete,
    }));
    stores.openSyncKeyedStore.mockReset().mockImplementation(() => ({
      entries: stores.syncEntries,
      register: stores.syncRegister,
      delete: stores.syncDelete,
      update: stores.syncUpdate,
      deleteIf: stores.syncDeleteIf,
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
      let manager: Awaited<ReturnType<typeof compatibilityManager>> | undefined;
      try {
        stores.syncEntries.mockReturnValueOnce([current]);
        ensureBindingsLoaded();
        manager = await compatibilityManager();
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

  it.each([false, true])(
    "keeps bindings in memory after unavailable startup (persist=%s)",
    async (persist) => {
      stores.entries.mockRejectedValueOnce(new Error("state unavailable"));
      const manager = persist
        ? await createThreadBindingManager({
            cfg: EMPTY_DISCORD_TEST_CONFIG,
            accountId: "work",
            persist: true,
            enableSweeper: false,
          })
        : await discordPlugin.conversationBindings!.createManager!({
            cfg: EMPTY_DISCORD_TEST_CONFIG,
            accountId: "work",
          });
      expect(manager).toBe(getThreadBindingManager("work"));
      const bindingManager = getThreadBindingManager("work")!;
      expect(bindingManager.listBindings()).toEqual([]);
      await bindingManager.bindTarget({
        threadId: "thread-1",
        channelId: "parent-1",
        targetKind: "subagent",
        targetSessionKey: "agent:main:subagent:child",
        agentId: "main",
        webhookId: "synthetic-webhook",
        webhookToken: "synthetic-token",
      });
      expect(bindingManager.getByThreadId("thread-1")?.targetSessionKey).toBe(
        "agent:main:subagent:child",
      );
      expect(stores.openSyncKeyedStore).not.toHaveBeenCalled();
      await bindingManager.stop();
    },
  );

  it("awaits committed touch and removal, preserves FIFO, and drains shutdown", async () => {
    stores.entries.mockResolvedValue([persistedBinding()]);
    const manager = await persistentManager();
    const entered = createDeferred<void>();
    const commit = createDeferred<void>();
    stores.register.mockImplementationOnce(async (_key, _value, options) => {
      entered.resolve();
      await commit.promise;
      options?.assertCurrent?.();
    });
    const touched = manager.touchThread({ threadId: "thread-1", at: 200 });
    expect(stores.openSyncKeyedStore).not.toHaveBeenCalled();
    await entered.promise;
    expect(manager.getByThreadId("thread-1")?.lastActivityAt).toBe(100);
    const removed = manager.unbindThread({ threadId: "thread-1", sendFarewell: false });
    let stopped = false;
    const stopping = manager.stop().then(() => {
      stopped = true;
    });
    try {
      await Promise.resolve();
      expect(stopped).toBe(false);
      expect(stores.delete).not.toHaveBeenCalled();
      expect(stores.openSyncKeyedStore).not.toHaveBeenCalled();
      await expect(manager.touchThread({ threadId: "thread-1" })).rejects.toThrow("stopping");
    } finally {
      commit.resolve();
      await Promise.all([touched, removed, stopping]);
    }
    expect(manager.getByThreadId("thread-1")).toBeUndefined();
    expect(getThreadBindingManager("work")).toBeNull();
    expect(stores.delete).toHaveBeenCalledOnce();
  });

  it("does not turn revoked bind authority into an in-memory fallback", async () => {
    stores.entries.mockResolvedValueOnce([persistedBinding()]);
    const manager = await persistentManager();
    const entered = createDeferred<void>();
    const commit = createDeferred<void>();
    let current = true;
    stores.register.mockImplementationOnce(async (_key, _value, options) => {
      entered.resolve();
      await commit.promise;
      options?.assertCurrent?.();
    });
    const binding = manager.bindTarget({
      threadId: "thread-1",
      channelId: "parent-1",
      targetKind: "subagent",
      targetSessionKey: "agent:main:subagent:replacement",
      agentId: "main",
      webhookId: "synthetic-webhook",
      webhookToken: "synthetic-token",
      assertCurrent: () => {
        if (!current) {
          throw new Error("binding authority revoked");
        }
      },
    });
    const outcome = expect(binding).rejects.toThrow("binding authority revoked");
    await entered.promise;
    current = false;
    commit.resolve();
    await outcome;
    expect(manager.getByThreadId("thread-1")).toEqual(persistedBinding().value);
    await manager.stop();
  });

  it.each(["register", "delete"] as const)(
    "retains the in-memory fallback after a failed %s",
    async (operation) => {
      stores.entries.mockResolvedValue([persistedBinding()]);
      const manager = await persistentManager();
      stores[operation].mockRejectedValueOnce(new Error("persistence failed"));
      try {
        const mutation =
          operation === "register"
            ? manager.bindTarget({
                threadId: "thread-1",
                channelId: "parent-1",
                targetKind: "subagent",
                targetSessionKey: "agent:main:subagent:replacement",
                agentId: "main",
                webhookId: "synthetic-webhook",
                webhookToken: "synthetic-token",
              })
            : manager.unbindThread({ threadId: "thread-1", sendFarewell: false });
        await mutation;
        expect(manager.getByThreadId("thread-1")?.targetSessionKey).toBe(
          operation === "register" ? "agent:main:subagent:replacement" : undefined,
        );
        expect(stores[operation]).toHaveBeenCalledOnce();
        expect(stores.openSyncKeyedStore).not.toHaveBeenCalled();
      } finally {
        await manager.stop();
      }
    },
  );

  it.each([
    ["before-commit", "target", "touch"],
    ["after-commit", "target", "touch"],
    ["before-commit", "sibling", "touch"],
    ["after-commit", "sibling", "touch"],
    ["after-prefix", "sibling", "touch"],
    ["before-commit", "target", "idle"],
    ["after-commit", "target", "idle"],
    ["before-commit", "target", "unbind"],
    ["after-commit", "target", "unbind"],
    ["after-commit", "target", "touch-failed-write"],
  ] as const)(
    "settles %s writes against synchronous %s %s",
    async (boundary, touchedRecord, compatibility) => {
      const saved = persistedBinding();
      const sibling = persistedBinding("agent:main:subagent:sibling");
      sibling.key = "work:thread-2";
      sibling.value.threadId = "thread-2";
      const rows = installCanonicalRows(
        boundary === "after-prefix"
          ? [
              [sibling.key, sibling.value],
              [saved.key, saved.value],
            ]
          : [
              [saved.key, saved.value],
              [sibling.key, sibling.value],
            ],
      );
      const manager = await persistentManager();
      const entered = createDeferred<void>();
      const finish = createDeferred<void>();
      stores.register.mockImplementationOnce(async (key, value, options) => {
        if (boundary === "before-commit") {
          entered.resolve();
          await finish.promise;
        }
        options?.assertCurrent?.();
        rows.set(key, value);
        if (boundary !== "before-commit") {
          entered.resolve();
          await finish.promise;
        }
      });
      const binding = manager.bindTarget({
        threadId: "thread-1",
        channelId: "parent-1",
        targetKind: "subagent",
        targetSessionKey: "agent:main:subagent:replacement",
        agentId: "main",
        webhookId: "synthetic-webhook",
        webhookToken: "synthetic-token",
      });
      const outcome =
        boundary !== "after-commit"
          ? expect(binding).rejects.toThrow(
              boundary === "after-prefix"
                ? "after 1 acknowledged writes"
                : "changed during persistence",
            )
          : expect(binding).resolves.toMatchObject({
              targetSessionKey: "agent:main:subagent:replacement",
            });
      await entered.promise;
      const touchedId = touchedRecord === "target" ? "thread-1" : "thread-2";
      const at = Date.now() + 1;
      if (compatibility === "touch" || compatibility === "touch-failed-write") {
        if (compatibility === "touch-failed-write") {
          stores.syncUpdate.mockImplementationOnce((key, update) => {
            update(rows.get(key));
            throw new Error("native write failed after reading its canonical row");
          });
        }
        expect(
          getSessionBindingService().touch(`work:${touchedId}`, at, {
            channel: "discord",
            accountId: "work",
          }),
        ).toBeUndefined();
        if (compatibility === "touch") {
          expect(rows.get(`work:${touchedId}`)?.lastActivityAt).toBe(at);
        }
      } else if (compatibility === "idle") {
        const updated = discordPlugin.conversationBindings!.setIdleTimeoutBySessionKey!({
          targetSessionKey: saved.value.targetSessionKey,
          accountId: "work",
          idleTimeoutMs: 500,
        });
        expect(updated).toHaveLength(boundary === "after-commit" ? 0 : 1);
        expect(rows.get(saved.key)?.idleTimeoutMs === 500).toBe(boundary !== "after-commit");
      } else {
        const removed = unbindThreadBindingsBySessionKey({
          targetSessionKey: saved.value.targetSessionKey,
          sendFarewell: false,
        });
        expect(removed).toHaveLength(boundary === "after-commit" ? 0 : 1);
        expect(rows.has(saved.key)).toBe(boundary === "after-commit");
      }
      finish.resolve();
      await outcome;
      expect(stores.warn).toHaveBeenCalledWith(
        "Discord thread binding save interrupted; acknowledged writes were retained.",
        {
          committedWrites: boundary === "before-commit" ? 0 : 1,
          targetCommitted: boundary === "after-commit",
        },
      );
      expect(manager.getByThreadId("thread-1")?.targetSessionKey).toBe(
        boundary === "after-commit"
          ? "agent:main:subagent:replacement"
          : compatibility === "unbind"
            ? undefined
            : saved.value.targetSessionKey,
      );
      if (compatibility === "touch" || compatibility === "touch-failed-write") {
        expect(manager.getByThreadId(touchedId)?.lastActivityAt).toBe(at);
      }
      await manager.stop();
    },
  );

  it("does not resurrect a committed removal when synchronous touch runs before acknowledgement", async () => {
    const saved = persistedBinding();
    const rows = installCanonicalRows([[saved.key, saved.value]]);
    const manager = await persistentManager();
    const entered = createDeferred<void>();
    const finish = createDeferred<void>();
    stores.delete.mockImplementationOnce(async (key, options) => {
      options?.assertCurrent?.();
      const removed = rows.delete(key);
      entered.resolve();
      await finish.promise;
      return removed;
    });
    const removed = manager.unbindThread({ threadId: "thread-1", sendFarewell: false });
    try {
      await entered.promise;
      getSessionBindingService().touch(saved.key, 200, { channel: "discord", accountId: "work" });
      expect(rows.has(saved.key)).toBe(false);
      expect(manager.getByThreadId("thread-1")).toEqual(saved.value);
      finish.resolve();
      expect(await removed).toEqual(saved.value);
      expect(manager.getByThreadId("thread-1")).toBeUndefined();
    } finally {
      finish.resolve();
      try {
        await removed;
      } finally {
        await manager.stop();
      }
    }
  });

  it("captures nested metadata before waiting behind another mutation", async () => {
    const saved = persistedBinding();
    const rows = installCanonicalRows([[saved.key, saved.value]]);
    const manager = await persistentManager();
    const entered = createDeferred<void>();
    const finish = createDeferred<void>();
    stores.register.mockImplementationOnce(async (key, value, options) => {
      entered.resolve();
      await finish.promise;
      options?.assertCurrent?.();
      rows.set(key, value);
    });
    const touching = manager.touchThread({ threadId: "thread-1", at: 200 });
    await entered.promise;
    const metadata = { payload: { value: "captured", items: [{ text: "first" }] } };
    const binding = manager.bindTarget({
      threadId: "thread-1",
      channelId: "parent-1",
      targetKind: "subagent",
      targetSessionKey: "agent:main:subagent:replacement",
      agentId: "main",
      webhookId: "synthetic-webhook",
      webhookToken: "synthetic-token",
      metadata,
    });
    metadata.payload.value = "changed";
    metadata.payload.items[0]!.text = "changed";
    metadata.payload.items.push({ text: "extra" });
    finish.resolve();
    await touching;
    const bound = await binding;
    expect(bound?.metadata).toEqual({ payload: { value: "captured", items: [{ text: "first" }] } });
    expect(rows.get(saved.key)?.metadata).toEqual(bound?.metadata);
    await manager.stop();
  });

  registerThreadBindingCompatibilityTests({ stores, persistedBinding, persistentManager });

  it("refuses to acquire a manager that appeared after session mutation admission", async () => {
    const saved = persistedBinding();
    const orphan = persistedBinding("agent:other:subagent:child");
    orphan.key = "other:thread-2";
    orphan.value.accountId = "other";
    orphan.value.threadId = "thread-2";
    const rows = installCanonicalRows([
      [saved.key, saved.value],
      [orphan.key, orphan.value],
    ]);
    const manager = await persistentManager();
    const entered = createDeferred<void>();
    const finish = createDeferred<void>();
    stores.register.mockImplementationOnce(async (key, value, options) => {
      entered.resolve();
      await finish.promise;
      options?.assertCurrent?.();
      rows.set(key, value);
    });
    const touching = manager.touchThread({ threadId: "thread-1", at: 200 });
    await entered.promise;
    const creating = createThreadBindingManager({
      cfg: EMPTY_DISCORD_TEST_CONFIG,
      accountId: "other",
      persist: false,
      enableSweeper: false,
    });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    const setting = discordPlugin.conversationBindings!.setIdleTimeoutBySessionKeyAsync!({
      targetSessionKey: orphan.value.targetSessionKey,
      accountId: "other",
      idleTimeoutMs: 500,
    });
    const outcome = expect(setting).rejects.toThrow("manager changed");
    try {
      expect(getThreadBindingManager("other")).toBeNull();
      finish.resolve();
      const [, otherManager] = await Promise.all([touching, creating, outcome]);
      expect(rows.get(orphan.key)?.idleTimeoutMs).toBeUndefined();
      expect(otherManager.getByThreadId("thread-2")?.idleTimeoutMs).toBeUndefined();
    } finally {
      finish.resolve();
      await Promise.allSettled([touching, creating, setting]);
      await manager.stop();
      await getThreadBindingManager("other")?.stop();
    }
  });

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
    const otherManager = await createThreadBindingManager({
      cfg: EMPTY_DISCORD_TEST_CONFIG,
      accountId: "other",
      persist: false,
      enableSweeper: false,
    });
    const entered = createDeferred<void>();
    const finish = createDeferred<void>();
    stores.register.mockImplementationOnce(async (key, value, options) => {
      entered.resolve();
      await finish.promise;
      options?.assertCurrent?.();
      rows.set(key, value);
    });
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

  it.each([false, true])(
    "handles a real native read-only failure without guessing pending ownership (pending=%s)",
    async (pending) => {
      await withOpenClawTestState({ label: "discord-binding-native-readonly" }, async () => {
        const entered = createDeferred<void>();
        const finish = createDeferred<void>();
        stores.openKeyedStore.mockImplementation((options) => {
          const store = createPluginStateKeyedStoreForTests<ThreadBindingRecord>(
            "discord",
            options,
          );
          return {
            ...store,
            register: async (...args: Parameters<typeof store.register>) => {
              await store.register(...args);
              entered.resolve();
              await finish.promise;
            },
          };
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
        const original = manager.getByThreadId("thread-1");
        const replacement = pending
          ? manager.bindTarget({
              threadId: "thread-1",
              channelId: "parent-1",
              targetKind: "subagent",
              targetSessionKey: "agent:main:subagent:replacement",
              agentId: "main",
              webhookId: "synthetic-webhook",
              webhookToken: "synthetic-token",
            })
          : undefined;
        const database = openOpenClawStateDatabase();
        try {
          if (pending) {
            await entered.promise;
          }
          database.db.exec("PRAGMA query_only = ON");
          getSessionBindingService().touch(saved.key, 200, {
            channel: "discord",
            accountId: "work",
          });
          expect(observed).toBe(false);
          if (pending) {
            expect(manager.getByThreadId("thread-1")).toBe(original);
          } else {
            expect(manager.getByThreadId("thread-1")?.lastActivityAt).toBe(200);
          }
        } finally {
          database.db.exec("PRAGMA query_only = OFF");
          finish.resolve();
          await replacement;
          await manager.stop();
        }
        expect(manager.getByThreadId("thread-1")?.targetSessionKey).toBe(
          pending ? "agent:main:subagent:replacement" : saved.value.targetSessionKey,
        );
        expect(store.lookup(saved.key)?.targetSessionKey).toBe(
          manager.getByThreadId("thread-1")?.targetSessionKey,
        );
        await resetThreadBindingsForTests();
        resetPluginStateStoreForTests();
      });
    },
  );

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

  it.each(["worker", "compatibility"] as const)(
    "restores real SQLite rows and settles %s mutations",
    async (mode) => {
      await withOpenClawTestState({ label: "discord-thread-binding-restore" }, async () => {
        stores.openKeyedStore.mockImplementation((options) =>
          createPluginStateKeyedStoreForTests<ThreadBindingRecord>("discord", options),
        );
        stores.openSyncKeyedStore.mockImplementation((options) =>
          createPluginStateSyncKeyedStoreForTests<ThreadBindingRecord>("discord", options),
        );
        const saved = persistedBinding();
        const store = createPluginStateSyncKeyedStoreForTests<ThreadBindingRecord>("discord", {
          namespace: "thread-bindings",
          maxEntries: 10_000,
        });
        try {
          store.register(saved.key, saved.value);
          const manager = await createThreadBindingManager({
            cfg: EMPTY_DISCORD_TEST_CONFIG,
            accountId: "work",
            persist: mode === "worker",
            enableSweeper: false,
          });
          expect(manager.getByThreadId("thread-1")).toEqual(saved.value);
          expect(stores.openSyncKeyedStore).not.toHaveBeenCalled();
          if (mode === "worker") {
            await manager.touchThread({ threadId: "thread-1", at: 200 });
            expect(store.lookup(saved.key)?.lastActivityAt).toBe(200);
            expect(
              await manager.unbindThread({ threadId: "thread-1", sendFarewell: false }),
            ).not.toBeNull();
            expect(stores.openSyncKeyedStore).not.toHaveBeenCalled();
          } else {
            expect(
              unbindThreadBindingsBySessionKey({
                targetSessionKey: saved.value.targetSessionKey,
                sendFarewell: false,
              }),
            ).toHaveLength(1);
          }
          expect(store.lookup(saved.key)).toBeUndefined();
          await manager.stop();
        } finally {
          await resetThreadBindingsForTests();
          resetPluginStateStoreForTests();
        }
      });
    },
  );
});
