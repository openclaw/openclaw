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
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { withOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { discordPlugin } from "../channel.js";
import { EMPTY_DISCORD_TEST_CONFIG } from "../test-support/config.js";
import { unbindThreadBindingsBySessionKey } from "./thread-bindings.lifecycle.js";
import { createThreadBindingManager, getThreadBindingManager } from "./thread-bindings.manager.js";
import { ensureBindingsLoadedAsync } from "./thread-bindings.state.js";
import { resetThreadBindingsForTests } from "./thread-bindings.test-support.js";
import type { ThreadBindingRecord } from "./thread-bindings.types.js";

const stores = vi.hoisted(() => {
  const entries = vi.fn<() => Promise<PluginStateEntry<ThreadBindingRecord>[]>>();
  const syncEntries = vi.fn<() => PluginStateEntry<ThreadBindingRecord>[]>();
  return {
    entries,
    syncEntries,
    openKeyedStore: vi.fn(
      (
        _options: OpenKeyedStoreOptions,
      ): Pick<PluginStateKeyedStore<ThreadBindingRecord>, "entries"> => ({ entries }),
    ),
    openSyncKeyedStore: vi.fn(
      (
        _options: OpenKeyedStoreOptions,
      ): Pick<PluginStateSyncKeyedStore<ThreadBindingRecord>, "entries"> => ({
        entries: syncEntries,
      }),
    ),
  };
});

vi.mock("../runtime.js", () => {
  const runtime = { state: stores };
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

describe("Discord thread binding restoration", () => {
  beforeEach(() => {
    resetThreadBindingsForTests();
    stores.entries.mockReset().mockResolvedValue([]);
    stores.syncEntries.mockReset().mockReturnValue([]);
    stores.openKeyedStore.mockReset().mockImplementation(() => ({ entries: stores.entries }));
    stores.openSyncKeyedStore
      .mockReset()
      .mockImplementation(() => ({ entries: stores.syncEntries }));
  });

  afterEach(() => {
    resetThreadBindingsForTests();
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
      let manager: ReturnType<typeof compatibilityManager> | undefined;
      try {
        stores.syncEntries.mockReturnValueOnce([current]);
        manager = compatibilityManager();
        manager.touchThread({ threadId: "thread-1", at: 200, persist: false });
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

  it("preserves best-effort initialization failure without falling back to a synchronous read", async () => {
    stores.entries.mockRejectedValueOnce(new Error("state unavailable"));
    const manager = await discordPlugin.conversationBindings!.createManager!({
      cfg: EMPTY_DISCORD_TEST_CONFIG,
      accountId: "work",
    });
    expect(manager).toBe(getThreadBindingManager("work"));
    expect(getThreadBindingManager("work")?.listBindings()).toEqual([]);
    expect(stores.openSyncKeyedStore).not.toHaveBeenCalled();
  });

  it("restores real SQLite rows asynchronously and retains immediate synchronous unbind persistence", async () => {
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
        await discordPlugin.conversationBindings!.createManager!({
          cfg: EMPTY_DISCORD_TEST_CONFIG,
          accountId: "work",
        });
        expect(getThreadBindingManager("work")?.getByThreadId("thread-1")).toEqual(saved.value);
        expect(stores.openSyncKeyedStore).not.toHaveBeenCalled();
        expect(
          unbindThreadBindingsBySessionKey({
            targetSessionKey: saved.value.targetSessionKey,
            sendFarewell: false,
          }),
        ).toHaveLength(1);
        expect(store.lookup(saved.key)).toBeUndefined();
      } finally {
        resetThreadBindingsForTests();
        resetPluginStateStoreForTests();
      }
    });
  });
});
