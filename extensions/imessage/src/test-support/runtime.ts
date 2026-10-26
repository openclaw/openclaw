import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import type { OpenKeyedStoreOptions } from "openclaw/plugin-sdk/plugin-state-runtime";
import * as initialStateRuntime from "openclaw/plugin-sdk/plugin-state-test-runtime";
import type { PluginRuntime } from "openclaw/plugin-sdk/runtime-store";
import { useSessionStoreTempDirs } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterAll, vi } from "vitest";
import { setIMessageRuntime } from "../runtime.js";

const tempDirs = useSessionStoreTempDirs(afterAll, "openclaw-imessage-state-");
const createIMessageTestEnv = () => ({ ...process.env, OPENCLAW_STATE_DIR: tempDirs.make() });

let env = createIMessageTestEnv();
let stateRuntime = initialStateRuntime;
const reusedStoreCleanups = new Map<string, () => Promise<void>>();

export function createIMessagePluginStateSyncStoreForTest<T>(options: OpenKeyedStoreOptions) {
  return stateRuntime.createPluginStateSyncKeyedStoreForTests<T>("imessage", { ...options, env });
}

function installRuntime(
  setRuntime: typeof setIMessageRuntime,
  { reuseDatabase = false, failStores = false } = {},
): void {
  const failStore = () => {
    throw new Error("test plugin-state failure");
  };
  setRuntime({
    state: {
      resolveStateDir: () => env.OPENCLAW_STATE_DIR,
      openChannelIngressQueue: (options) =>
        stateRuntime.createChannelIngressQueueForTests({
          ...options,
          channelId: "imessage",
          stateDir: options?.stateDir ?? env.OPENCLAW_STATE_DIR,
        }),
      openKeyedStoreV2: <T>(options: Parameters<PluginRuntime["state"]["openKeyedStoreV2"]>[0]) => {
        if (failStores) {
          return failStore();
        }
        const store = stateRuntime.createPluginStateKeyedStoreV2ForTests<T>(
          "imessage",
          { ...options, env },
          { assertCurrent: () => {} },
        );
        if (reuseDatabase) {
          reusedStoreCleanups.set(options.namespace, store.clear);
        }
        return store;
      },
      openSyncKeyedStore: failStores ? failStore : createIMessagePluginStateSyncStoreForTest,
    },
    channel: { inbound: { ingress: createPluginRuntimeMock().channel.inbound.ingress } },
  } as PluginRuntime);
  if (failStores) {
    return;
  }
  for (const options of [
    { namespace: "imessage.reply-cache", maxEntries: 2000 },
    { namespace: "imessage.reply-cache-counter", maxEntries: 1 },
  ]) {
    createIMessagePluginStateSyncStoreForTest(options).entries();
  }
}

export function installIMessageStateRuntimeForTest(): void {
  env = createIMessageTestEnv();
  stateRuntime.resetPluginStateStoreForTests({ closeDatabase: false });
  installRuntime(setIMessageRuntime);
}

export async function loadFreshIMessageReplyCacheForTest(options?: {
  preservePersistentState?: boolean;
  reuseDatabase?: boolean;
}): Promise<typeof import("../monitor-reply-cache.js")> {
  if (options?.reuseDatabase && !options.preservePersistentState) {
    // Clear through the real worker boundary while retaining its prepared database.
    for (const clear of reusedStoreCleanups.values()) {
      await clear();
    }
  } else if (!options?.preservePersistentState) {
    const { closeOpenClawStateDatabaseAsync } =
      await import("openclaw/plugin-sdk/sqlite-runtime-testing");
    // Drain worker-only stores before rotating the fixture state directory.
    await closeOpenClawStateDatabaseAsync();
    stateRuntime.closeOpenClawStateDatabaseForTest();
    env = createIMessageTestEnv();
  }
  if (!options?.preservePersistentState) {
    reusedStoreCleanups.clear();
  }
  stateRuntime.resetPluginStateStoreForTests({ closeDatabase: !options?.reuseDatabase });
  vi.resetModules();
  // Store factories and their lazy worker admissions must share one module generation.
  stateRuntime = await import("openclaw/plugin-sdk/plugin-state-test-runtime");
  const { setIMessageRuntime: setFreshIMessageRuntime } = await import("../runtime.js");
  installRuntime(setFreshIMessageRuntime, { reuseDatabase: options?.reuseDatabase });
  return await import("../monitor-reply-cache.js");
}

export function installIMessageFailingStateRuntimeForTest(): void {
  stateRuntime.closeOpenClawStateDatabaseForTest();
  env = createIMessageTestEnv();
  installRuntime(setIMessageRuntime, { failStores: true });
}
