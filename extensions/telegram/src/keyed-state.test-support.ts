import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import type { OpenAsyncKeyedStoreOptions } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { createTempHomeEnv, type TempHomeEnv } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach } from "vitest";
import { setTelegramRuntime } from "./runtime.js";
import { clearTelegramRuntimeForTest } from "./runtime.test-support.js";
import type { TelegramRuntime } from "./runtime.types.js";

export function useTelegramKeyedState<T>(options: OpenAsyncKeyedStoreOptions, version: 1 | 2 = 1) {
  type Store = ReturnType<typeof createPluginStateKeyedStoreForTests<T>>;
  let store: Store;
  let home: TempHomeEnv;
  const open = () => createPluginStateKeyedStoreForTests<T>("telegram", options);
  const install = (next: Store) => {
    store = next;
    setTelegramRuntime(
      createPluginRuntimeMock({
        state:
          version === 1
            ? { openKeyedStore: (() => store) as TelegramRuntime["state"]["openKeyedStore"] }
            : {
                openKeyedStoreV2: (() =>
                  store.withCurrent({
                    assertCurrent() {},
                  })) as TelegramRuntime["state"]["openKeyedStoreV2"],
              },
      }),
    );
  };
  beforeEach(async () => {
    home = await createTempHomeEnv("telegram-keyed-state-");
    resetPluginStateStoreForTests({ closeDatabase: false });
    install(open());
    await store.clear();
  });
  afterEach(async () => {
    try {
      clearTelegramRuntimeForTest();
      resetPluginStateStoreForTests();
    } finally {
      await home?.restore();
    }
  });
  return {
    open,
    install,
    get store() {
      return store;
    },
  };
}
