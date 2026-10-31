import fs from "node:fs";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import type {
  OpenKeyedStoreOptions,
  PluginStateSyncKeyedStore,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import * as initialStateRuntime from "openclaw/plugin-sdk/plugin-state-test-runtime";
import type { PluginRuntime } from "openclaw/plugin-sdk/runtime-store";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterAll, vi } from "vitest";
import { setIMessageRuntime } from "../runtime.js";

// Vitest runs afterAll hooks in reverse order, so databases close before directory removal.
const tempDirs = useAutoCleanupTempDirTracker(afterAll);

afterAll(async () => {
  const { closeOpenClawAgentDatabasesAsync, closeOpenClawStateDatabaseAsync } =
    await import("openclaw/plugin-sdk/sqlite-runtime-testing");
  await closeOpenClawAgentDatabasesAsync();
  await closeOpenClawStateDatabaseAsync();
});

function createIMessageTestEnv(): NodeJS.ProcessEnv & { OPENCLAW_STATE_DIR: string } {
  const stateDir = fs.realpathSync(
    tempDirs.make("openclaw-imessage-state-", resolvePreferredOpenClawTmpDir()),
  );
  return { ...process.env, OPENCLAW_STATE_DIR: stateDir };
}

let imessageTestEnv = createIMessageTestEnv();
let stateRuntime = initialStateRuntime;
const reusedStoreCleanups = new Map<string, () => Promise<void>>();

export function createIMessagePluginStateSyncStoreForTest<T>(
  options: OpenKeyedStoreOptions,
): PluginStateSyncKeyedStore<T> {
  return stateRuntime.createPluginStateSyncKeyedStoreForTests<T>("imessage", {
    ...options,
    env: imessageTestEnv,
  });
}

export function importIMessageLegacyPluginStateForTest(
  options: OpenKeyedStoreOptions,
  entries: Parameters<typeof stateRuntime.importPluginStateEntriesForDoctorForTests>[2],
): void {
  stateRuntime.importPluginStateEntriesForDoctorForTests(
    "imessage",
    { ...options, env: imessageTestEnv },
    entries,
  );
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
      resolveStateDir: () => imessageTestEnv.OPENCLAW_STATE_DIR,
      openChannelIngressQueue: (
        options?: Omit<
          Parameters<typeof stateRuntime.createChannelIngressQueueForTests>[0],
          "channelId"
        >,
      ) =>
        stateRuntime.createChannelIngressQueueForTests({
          ...options,
          channelId: "imessage",
          stateDir: options?.stateDir ?? imessageTestEnv.OPENCLAW_STATE_DIR,
        }),
      openKeyedStoreV2: (failStores
        ? failStore
        : (options) => {
            const store = stateRuntime
              .createPluginStateKeyedStoreForTests("imessage", {
                ...options,
                env: imessageTestEnv,
              })
              .withCurrent({ assertCurrent: () => {} });
            if (reuseDatabase) {
              reusedStoreCleanups.set(options.namespace, store.clear);
            }
            return store;
          }) as PluginRuntime["state"]["openKeyedStoreV2"],
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
  imessageTestEnv = createIMessageTestEnv();
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
    imessageTestEnv = createIMessageTestEnv();
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
  imessageTestEnv = createIMessageTestEnv();
  installRuntime(setIMessageRuntime, { failStores: true });
}
