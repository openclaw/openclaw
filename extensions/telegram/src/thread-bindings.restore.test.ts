// Telegram tests cover async thread binding restoration at startup entry points.
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
import { telegramPlugin } from "./channel.js";
import {
  resolveStoredBindingKey,
  TELEGRAM_THREAD_BINDINGS_MAX_ENTRIES,
  TELEGRAM_THREAD_BINDINGS_NAMESPACE,
  type TelegramThreadBindingRecord,
} from "./thread-bindings-store.js";
import {
  createTelegramThreadBindingManager,
  ensureTelegramThreadBindingsLoadedAsync,
  getTelegramThreadBindingManager,
} from "./thread-bindings.js";
import { resetTelegramThreadBindingsForTests } from "./thread-bindings.test-support.js";

const readAcpSessionEntryMock = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/acp-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/acp-runtime")>(
    "openclaw/plugin-sdk/acp-runtime",
  );
  readAcpSessionEntryMock.mockImplementation(actual.readAcpSessionEntry);
  return {
    ...actual,
    readAcpSessionEntry: readAcpSessionEntryMock,
  };
});

const stores = vi.hoisted(() => {
  const entries = vi.fn<() => Promise<PluginStateEntry<TelegramThreadBindingRecord>[]>>();
  const syncEntries = vi.fn<() => PluginStateEntry<TelegramThreadBindingRecord>[]>();
  return {
    entries,
    syncEntries,
    openKeyedStore: vi.fn(
      (
        _options: OpenKeyedStoreOptions,
      ): Pick<PluginStateKeyedStore<TelegramThreadBindingRecord>, "entries"> => ({ entries }),
    ),
    openSyncKeyedStore: vi.fn(
      (
        _options: OpenKeyedStoreOptions,
      ): Pick<PluginStateSyncKeyedStore<TelegramThreadBindingRecord>, "entries"> => ({
        entries: syncEntries,
      }),
    ),
  };
});

vi.mock("./runtime.js", () => {
  const runtime = { state: stores };
  return { getTelegramRuntime: () => runtime, getOptionalTelegramRuntime: () => runtime };
});

const TEST_CFG = { channels: { telegram: { token: "test-token" } } } as Parameters<
  NonNullable<NonNullable<typeof telegramPlugin.conversationBindings>["createManager"]>
>[0]["cfg"];

function persistedBinding(targetSessionKey = "agent:main:subagent:child") {
  const value: TelegramThreadBindingRecord = {
    accountId: "work",
    conversationId: "-100200:topic:1",
    targetKind: "subagent",
    targetSessionKey,
    boundAt: 100,
    lastActivityAt: 100,
  };
  return {
    key: resolveStoredBindingKey({
      accountId: value.accountId,
      conversationId: value.conversationId,
    }),
    value,
    createdAt: 100,
  };
}

function compatibilityManager(accountId = "work") {
  return createTelegramThreadBindingManager({
    cfg: TEST_CFG,
    accountId,
    persist: false,
    enableSweeper: false,
  });
}

describe("Telegram thread binding restoration", () => {
  beforeEach(() => {
    resetTelegramThreadBindingsForTests();
    readAcpSessionEntryMock.mockClear().mockImplementation(() => undefined);
    stores.entries.mockReset().mockResolvedValue([]);
    stores.syncEntries.mockReset().mockReturnValue([]);
    stores.openKeyedStore.mockReset().mockImplementation(() => ({ entries: stores.entries }));
    stores.openSyncKeyedStore
      .mockReset()
      .mockImplementation(() => ({ entries: stores.syncEntries }));
  });

  afterEach(() => {
    resetTelegramThreadBindingsForTests();
  });

  it("awaits the cold read per account before publishing channel binding managers", async () => {
    const ready = createDeferred<PluginStateEntry<TelegramThreadBindingRecord>[]>();
    const entered = createDeferred<void>();
    stores.entries.mockImplementationOnce(() => {
      entered.resolve();
      return ready.promise;
    });
    stores.syncEntries.mockImplementation(() => {
      entered.resolve();
      return [];
    });
    const createManager = telegramPlugin.conversationBindings!.createManager!;
    const first = Promise.resolve(createManager({ cfg: TEST_CFG, accountId: "work" }));
    const second = Promise.resolve(createManager({ cfg: TEST_CFG, accountId: "other" }));
    try {
      await entered.promise;
      expect(getTelegramThreadBindingManager("work")).toBeNull();
      expect(stores.openSyncKeyedStore).not.toHaveBeenCalled();
    } finally {
      ready.resolve([persistedBinding()]);
      await Promise.all([first, second]);
    }
    expect(getTelegramThreadBindingManager("work")?.getByConversationId("-100200:topic:1")).toEqual(
      persistedBinding().value,
    );
    expect(getTelegramThreadBindingManager("other")?.listBindings()).toEqual([]);
    expect(stores.openSyncKeyedStore).not.toHaveBeenCalled();
  });

  it.each(["resolve", "reject"] as const)(
    "keeps newer synchronous initialization when an older async read %ss",
    async (settlement) => {
      const ready = createDeferred<PluginStateEntry<TelegramThreadBindingRecord>[]>();
      stores.entries.mockReturnValueOnce(ready.promise);
      const loading = ensureTelegramThreadBindingsLoadedAsync("work", { persist: false });
      const current = persistedBinding("agent:main:subagent:replacement");
      let manager: ReturnType<typeof compatibilityManager> | undefined;
      try {
        stores.syncEntries.mockReturnValueOnce([current]);
        manager = compatibilityManager();
        manager.touchConversation("-100200:topic:1", 200);
        expect(manager.getByConversationId("-100200:topic:1")?.targetSessionKey).toBe(
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
      expect(manager?.getByConversationId("-100200:topic:1")).toEqual({
        ...current.value,
        lastActivityAt: 200,
      });
    },
  );

  it("preserves best-effort initialization failure without falling back to a synchronous read", async () => {
    stores.entries.mockRejectedValueOnce(new Error("state unavailable"));
    const manager = await telegramPlugin.conversationBindings!.createManager!({
      cfg: TEST_CFG,
      accountId: "work",
    });
    expect(manager).toBe(getTelegramThreadBindingManager("work"));
    expect(getTelegramThreadBindingManager("work")?.listBindings()).toEqual([]);
    expect(stores.openSyncKeyedStore).not.toHaveBeenCalled();
  });

  it("restores real SQLite rows asynchronously without touching the synchronous read", async () => {
    await withOpenClawTestState({ label: "telegram-thread-binding-restore" }, async () => {
      resetPluginStateStoreForTests();
      stores.openKeyedStore.mockImplementation((options) =>
        createPluginStateKeyedStoreForTests<TelegramThreadBindingRecord>("telegram", options),
      );
      stores.openSyncKeyedStore.mockImplementation((options) =>
        createPluginStateSyncKeyedStoreForTests<TelegramThreadBindingRecord>("telegram", options),
      );
      const saved = persistedBinding();
      const store = createPluginStateSyncKeyedStoreForTests<TelegramThreadBindingRecord>(
        "telegram",
        {
          namespace: TELEGRAM_THREAD_BINDINGS_NAMESPACE,
          maxEntries: TELEGRAM_THREAD_BINDINGS_MAX_ENTRIES,
        },
      );
      try {
        store.register(saved.key, saved.value);
        await ensureTelegramThreadBindingsLoadedAsync("work");
        // Restoration only fills the registry; the manager still publishes lazily.
        expect(getTelegramThreadBindingManager("work")).toBeNull();
        const manager = createTelegramThreadBindingManager({
          cfg: TEST_CFG,
          accountId: "work",
          persist: true,
          enableSweeper: false,
        });
        expect(manager.getByConversationId("-100200:topic:1")).toEqual(saved.value);
        expect(stores.syncEntries).not.toHaveBeenCalled();
        expect(
          manager.unbindBySessionKey({ targetSessionKey: saved.value.targetSessionKey }),
        ).toHaveLength(1);
        expect(store.lookup(saved.key)).toBeUndefined();
      } finally {
        store.clear();
      }
    });
  });
});
