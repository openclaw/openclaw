import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateKeyedStoreForTests,
  createPluginStateSyncKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { createOpenClawTestState, type OpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterEach, beforeEach, vi } from "vitest";
import { setTelegramRuntime } from "./runtime.js";
import { clearTelegramRuntimeForTest } from "./runtime.test-support.js";
import type { TelegramRuntime } from "./runtime.types.js";
import {
  TELEGRAM_THREAD_BINDINGS_MAX_ENTRIES,
  TELEGRAM_THREAD_BINDINGS_NAMESPACE,
  type TelegramThreadBindingRecord,
} from "./thread-bindings-store.js";
import { createTelegramThreadBindingManager } from "./thread-bindings.js";

export const TELEGRAM_THREAD_BINDINGS_TEST_CFG: OpenClawConfig = {
  channels: { telegram: { botToken: "test-token" } },
};

export function useTelegramThreadBindingsFixture() {
  let state: OpenClawTestState;
  let store: PluginStateKeyedStore<TelegramThreadBindingRecord>;
  const managers = new Set<Awaited<ReturnType<typeof createTelegramThreadBindingManager>>>();
  const stopManagers = async () => {
    for (const manager of managers) {
      await manager.stop();
    }
    managers.clear();
  };
  const installStore = (
    next: PluginStateKeyedStore<TelegramThreadBindingRecord>,
    allowLegacySync = false,
  ) => {
    store = next;
    setTelegramRuntime(
      createPluginRuntimeMock({
        state: {
          openSyncKeyedStore: <T>(
            options: Parameters<TelegramRuntime["state"]["openSyncKeyedStore"]>[0],
          ) => {
            if (!allowLegacySync) {
              throw new Error("Bundled bindings must not execute host SQLite");
            }
            return createPluginStateSyncKeyedStoreForTests<T>("telegram", options);
          },
          // SAFETY: This fixture serves only the thread-binding namespace and its canonical record type.
          openKeyedStore: (() => store) as TelegramRuntime["state"]["openKeyedStore"],
        },
      }),
    );
  };
  beforeEach(async () => {
    await stopManagers();
    state = await createOpenClawTestState({
      layout: "state-only",
      prefix: "openclaw-telegram-bindings-",
    });
    resetPluginStateStoreForTests({ closeDatabase: false });
    installStore(
      createPluginStateKeyedStoreForTests("telegram", {
        namespace: TELEGRAM_THREAD_BINDINGS_NAMESPACE,
        maxEntries: TELEGRAM_THREAD_BINDINGS_MAX_ENTRIES,
      }),
    );
    await store.clear();
  });
  afterEach(async () => {
    vi.useRealTimers();
    await stopManagers();
    clearTelegramRuntimeForTest();
    resetPluginStateStoreForTests();
    await state.cleanup();
  });
  return {
    get store() {
      return store;
    },
    installStore,
    storedBindings: async () => (await store.entries()).map((entry) => entry.value),
    createManager: async (
      params: Omit<Parameters<typeof createTelegramThreadBindingManager>[0], "cfg">,
    ) => {
      const manager = await createTelegramThreadBindingManager({
        cfg: TELEGRAM_THREAD_BINDINGS_TEST_CFG,
        ...params,
      });
      managers.add(manager);
      return manager;
    },
  };
}
