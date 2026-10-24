import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateKeyedStoreForTests,
  createPluginStateKeyedStoreV2ForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { createOpenClawTestState, type OpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterEach, beforeEach } from "vitest";
import {
  TELEGRAM_MESSAGE_CACHE_PERSISTENT_MAX_MESSAGES as maxEntries,
  TELEGRAM_MESSAGE_CACHE_PERSISTENT_NAMESPACE as namespace,
} from "./message-cache-persistence.js";
import { setTelegramRuntime } from "./runtime.js";
import {
  clearTelegramRuntimeForTest,
  resetTelegramMessageCacheForTest,
} from "./runtime.test-support.js";
import type { TelegramRuntime } from "./runtime.types.js";

export function photo(file_id: string) {
  return [{ file_id, file_unique_id: `${file_id}-unique`, width: 640, height: 480 }];
}

export function useMessageCacheFixture(prefix: string, interruptRetained = false) {
  let state: OpenClawTestState;
  const fixture = {
    beforeCompare: undefined as ((key: string) => Promise<void>) | undefined,
    beforeMove: undefined as (() => Promise<void>) | undefined,
    afterMove: undefined as (() => Promise<void>) | undefined,
    options: () => ({ namespace, maxEntries, env: state.env }),
    store<T>(retained = false) {
      return createPluginStateKeyedStoreForTests<T>(
        "telegram",
        retained ? { namespace, retention: "retained", env: state.env } : fixture.options(),
      );
    },
  };
  beforeEach(async () => {
    state = await createOpenClawTestState({ prefix, layout: "state-only" });
    fixture.beforeCompare = fixture.beforeMove = fixture.afterMove = undefined;
    const openKeyedStore: TelegramRuntime["state"]["openKeyedStoreV2"] = <T>(
      options: Parameters<TelegramRuntime["state"]["openKeyedStore"]>[0],
    ): PluginStateKeyedStore<T, 2> => {
      const store = createPluginStateKeyedStoreV2ForTests<T>(
        "telegram",
        { ...options, env: state.env },
        { assertCurrent() {} },
      );
      if (!interruptRetained || options.retention !== "retained") {
        return store;
      }
      return {
        ...store,
        async compareAndApply(key, comparison, intent) {
          const interrupt = fixture.beforeCompare;
          fixture.beforeCompare = undefined;
          await interrupt?.(key);
          return store.compareAndApply(key, comparison, intent);
        },
        async moveEntriesFrom(source) {
          await fixture.beforeMove?.();
          const moved = await store.moveEntriesFrom(source);
          const interrupt = fixture.afterMove;
          fixture.afterMove = undefined;
          await interrupt?.();
          return moved;
        },
      };
    };
    setTelegramRuntime(
      createPluginRuntimeMock({ state: { openKeyedStore, openKeyedStoreV2: openKeyedStore } }),
    );
  });
  afterEach(async () => {
    resetTelegramMessageCacheForTest();
    clearTelegramRuntimeForTest();
    resetPluginStateStoreForTests();
    await state.cleanup();
  });
  return fixture;
}
