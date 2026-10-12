import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import * as initialStateRuntime from "openclaw/plugin-sdk/plugin-state-test-runtime";
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

const acpHost = vi.hoisted(() => ({
  read: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/acp-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/acp-runtime")>(
    "openclaw/plugin-sdk/acp-runtime",
  );
  acpHost.read.mockImplementation(actual.readAcpSessionEntry);
  return {
    ...actual,
    readAcpSessionEntry: acpHost.read,
  };
});

export { acpHost };

export const TELEGRAM_THREAD_BINDINGS_TEST_CFG: OpenClawConfig = {
  channels: { telegram: { botToken: "test-token" } },
};

export function useTelegramThreadBindingsFixture() {
  let stateRuntime = initialStateRuntime;
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
            return stateRuntime.createPluginStateSyncKeyedStoreForTests<T>("telegram", options);
          },
          // SAFETY: This fixture serves only the thread-binding namespace and its canonical record type.
          openKeyedStore: (() => store) as TelegramRuntime["state"]["openKeyedStore"],
        },
      }),
    );
  };
  beforeEach(async () => {
    // A source-reload case may reset modules while retaining this fixture.
    stateRuntime = await import("openclaw/plugin-sdk/plugin-state-test-runtime");
    acpHost.read.mockReset();
    const acpRuntime = await vi.importActual<typeof import("openclaw/plugin-sdk/acp-runtime")>(
      "openclaw/plugin-sdk/acp-runtime",
    );
    acpHost.read.mockImplementation(acpRuntime.readAcpSessionEntry);
    await stopManagers();
    state = await createOpenClawTestState({
      layout: "state-only",
      prefix: "openclaw-telegram-bindings-",
    });
    stateRuntime.resetPluginStateStoreForTests({ closeDatabase: false });
    installStore(
      stateRuntime.createPluginStateKeyedStoreForTests("telegram", {
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
    stateRuntime.resetPluginStateStoreForTests();
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
