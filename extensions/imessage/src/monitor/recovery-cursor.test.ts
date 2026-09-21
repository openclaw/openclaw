import type {
  OpenAsyncKeyedStoreOptions,
  OpenKeyedStoreOptions,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getIMessageRuntime } from "../runtime.js";
import {
  createIMessagePluginStateSyncStoreForTest,
  installIMessageStateRuntimeForTest,
} from "../test-support/runtime.js";
import { advanceIMessageRecoveryCursor, loadIMessageRecoveryCursor } from "./recovery-cursor.js";

const hosts = ["current", "2026.9.4"] as const;
type Host = (typeof hosts)[number];
const accountId = "default";
const dbIdentity = "remote:synthetic:chat.db";
const cursorKey = `${accountId}\u0000${dbIdentity}`;
const cursorStoreOptions = { namespace: "imessage.recovery-cursor", maxEntries: 64 };

function seedCursor(rowid: number) {
  createIMessagePluginStateSyncStoreForTest<{ lastRowid: number }>(cursorStoreOptions).register(
    cursorKey,
    { lastRowid: rowid },
  );
}

function useHost(host: Host, options: { beforeWrite?: () => void; compareError?: Error } = {}) {
  const state = getIMessageRuntime().state;
  const openKeyedStore = state.openKeyedStore.bind(state);
  const openSyncKeyedStore = state.openSyncKeyedStore.bind(state);
  const syncOpen = vi
    .spyOn(state, "openSyncKeyedStore")
    .mockImplementation(<T>(storeOptions: OpenKeyedStoreOptions) => {
      const store = openSyncKeyedStore<T>(storeOptions);
      const update = store.update?.bind(store);
      if (options.beforeWrite && update) {
        store.update = (...args) => {
          options.beforeWrite?.();
          return update(...args);
        };
      }
      return store;
    });
  vi.spyOn(state, "openKeyedStore").mockImplementation(
    <T>(storeOptions: OpenAsyncKeyedStoreOptions) => {
      const store = openKeyedStore<T>(storeOptions);
      if (host === "2026.9.4") {
        delete store.observe;
        delete store.compareAndApply;
      } else if (store.compareAndApply && (options.beforeWrite || options.compareError)) {
        const compareAndApply = store.compareAndApply.bind(store);
        store.compareAndApply = async (...args) => {
          if (options.compareError) {
            throw options.compareError;
          }
          options.beforeWrite?.();
          return await compareAndApply(...args);
        };
      }
      return store;
    },
  );
  return syncOpen;
}

describe("iMessage recovery cursor persistence", () => {
  beforeEach(() => {
    installIMessageStateRuntimeForTest();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(hosts)("%s keeps the greatest row across concurrent completions", async (host) => {
    const syncOpen = useHost(host);
    await Promise.all(
      [30, 10, 50, 20, 40].map((rowid) =>
        advanceIMessageRecoveryCursor(accountId, dbIdentity, rowid),
      ),
    );
    expect(await loadIMessageRecoveryCursor(accountId, dbIdentity)).toBe(50);
    expect(await loadIMessageRecoveryCursor("other", dbIdentity)).toBeNull();
    expect(await loadIMessageRecoveryCursor(accountId, "remote:synthetic:other.db")).toBeNull();
    expect(syncOpen.mock.calls.length > 0).toBe(host === "2026.9.4");
  });

  it.each(hosts)("%s persists an expected-row rewind for a replaced database", async (host) => {
    seedCursor(9000);
    const syncOpen = useHost(host);
    expect(await loadIMessageRecoveryCursor(accountId, dbIdentity, { watermarkRowid: 5000 })).toBe(
      5000,
    );
    expect(await loadIMessageRecoveryCursor(accountId, dbIdentity)).toBe(5000);
    expect(syncOpen.mock.calls.length > 0).toBe(host === "2026.9.4");
  });

  it.each(hosts)("%s preserves a cursor changed before rewind admission", async (host) => {
    seedCursor(9000);
    const syncOpen = useHost(host, { beforeWrite: () => seedCursor(9100) });
    expect(await loadIMessageRecoveryCursor(accountId, dbIdentity, { watermarkRowid: 5000 })).toBe(
      9100,
    );
    expect(await loadIMessageRecoveryCursor(accountId, dbIdentity)).toBe(9100);
    expect(syncOpen.mock.calls.length > 0).toBe(host === "2026.9.4");
  });

  it.each(["advance", "rewind"] as const)(
    "does not fall back to sync storage after a modern %s comparison fails",
    async (operation) => {
      seedCursor(9000);
      const syncOpen = useHost("current", { compareError: new Error("synthetic CAS refusal") });
      if (operation === "advance") {
        await advanceIMessageRecoveryCursor(accountId, dbIdentity, 9100);
      } else {
        expect(
          await loadIMessageRecoveryCursor(accountId, dbIdentity, { watermarkRowid: 5000 }),
        ).toBe(5000);
      }
      expect(await loadIMessageRecoveryCursor(accountId, dbIdentity)).toBe(9000);
      expect(syncOpen).not.toHaveBeenCalled();
    },
  );
});
