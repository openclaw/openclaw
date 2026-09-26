import { existsSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import type {
  OpenAsyncKeyedStoreOptions,
  OpenKeyedStoreOptions,
  PluginStateKeyedStore,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createChannelIngressQueueForTests,
  createPluginStateKeyedStoreForTests,
  createPluginStateSyncKeyedStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import type { TelegramPollRegistryEntry } from "./poll-registry.js";
import { setTelegramRuntime } from "./runtime.js";
import type { TelegramRuntime } from "./runtime.types.js";

export function setTelegramPluginStateRuntimeForTests(): void {
  setTelegramRuntime(
    createPluginRuntimeMock({
      state: {
        openKeyedStore: <T>(options: OpenAsyncKeyedStoreOptions) =>
          createPluginStateKeyedStoreForTests<T>("telegram", options),
        openSyncKeyedStore: <T>(options: OpenKeyedStoreOptions) =>
          createPluginStateSyncKeyedStoreForTests<T>("telegram", options),
      },
    }),
  );
}

export function installTelegramIngressQueueRuntime(
  resolveStateDir: () => string,
  queueOpenError?: Error,
): void {
  setTelegramRuntime(
    createPluginRuntimeMock({
      state: {
        resolveStateDir,
        openKeyedStore: <T>(options: OpenAsyncKeyedStoreOptions) =>
          createPluginStateKeyedStoreForTests<T>("telegram", {
            ...options,
            env: { ...process.env, OPENCLAW_STATE_DIR: resolveStateDir() },
          }),
        openChannelIngressQueue: (
          options?: Omit<Parameters<typeof createChannelIngressQueueForTests>[0], "channelId">,
        ) => {
          if (queueOpenError) {
            throw queueOpenError;
          }
          return createChannelIngressQueueForTests({ ...options, channelId: "telegram" });
        },
      },
    }),
  );
}

export function setTelegramPollRegistryRuntimeForTests(
  store: PluginStateKeyedStore<TelegramPollRegistryEntry>,
): void {
  setTelegramRuntime(
    createPluginRuntimeMock({
      state: {
        openKeyedStore: (() => store) as TelegramRuntime["state"]["openKeyedStore"],
      },
    }),
  );
}

export function clearTelegramSessionStateFilesForTests(sessionStorePath: string): void {
  rmSync(`${sessionStorePath}.telegram-messages.json`, { force: true });
  const dir = path.dirname(sessionStorePath);
  if (!existsSync(dir)) {
    return;
  }
  const prefix = `${path.basename(sessionStorePath)}.telegram-message-dispatch-`;
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith(prefix)) {
      rmSync(path.join(dir, entry), { force: true });
    }
  }
}
