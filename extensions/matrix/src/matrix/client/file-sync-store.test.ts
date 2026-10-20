import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import type { ISyncResponse } from "matrix-js-sdk/lib/matrix.js";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  createPluginStateKeyedStoreForTests,
  openOpenClawStateDatabase,
  createPluginStateSyncKeyedStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import {
  closeOpenClawStateDatabaseAsync,
  observeHostDataSql,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { describe, expect, it, vi } from "vitest";
import { getMatrixRuntime } from "../../runtime.js";
import { SqliteBackedMatrixSyncStore } from "./file-sync-store.js";
import { openMatrixStorageMetaStoreOptions } from "./storage-metadata.js";
import {
  hasMatrixSyncCacheStateInStore,
  readPersistedStoreFromStore,
  openMatrixSyncCacheStoreOptions,
  type MatrixSyncCacheRecord,
} from "./sync-cache-state.js";
import { matrixSyncResponse, useSyncStoreFixture } from "./sync-store.test-support.js";

function createSyncResponse(nextBatch: string): ISyncResponse {
  const event = {
    content: { body: "hello", msgtype: "m.text" },
    event_id: "$message",
    origin_server_ts: 1,
    sender: "@user:example.org",
    type: "m.room.message",
  };
  return matrixSyncResponse(nextBatch, "!room:example.org", event, "t0", [
    { content: { theme: "dark" }, type: "com.openclaw.test" },
  ]);
}

describe("SqliteBackedMatrixSyncStore", () => {
  const storage = useSyncStoreFixture("openclaw-matrix-sync-store-");

  const openStore = () => SqliteBackedMatrixSyncStore.create(storage.root);
  const cacheOptions = () => openMatrixSyncCacheStoreOptions(storage.root);
  const syncCache = () =>
    createPluginStateSyncKeyedStoreForTests<MatrixSyncCacheRecord>("matrix", cacheOptions());
  const asyncCache = () =>
    createPluginStateKeyedStoreForTests<MatrixSyncCacheRecord>("matrix", cacheOptions());
  const invalidCache = { savedSync: null, cleanShutdown: false };
  async function seededStore(token: string, clean = false) {
    const store = await openStore();
    await store.setSyncData(createSyncResponse(token));
    if (clean) {
      store.markCleanShutdown();
    }
    await store.flush();
    return store;
  }

  it("loads, persists, deletes and closes the sync cache without host SQLite", async () => {
    const observation = observeHostDataSql();
    try {
      const store = await openStore();
      expect(store.hasSavedSync()).toBe(false);
      expect(fs.existsSync(path.join(storage.root, "state", "openclaw.sqlite"))).toBe(false);
      await store.setSyncData(createSyncResponse("worker-cursor"));
      await store.freezeSyncCursorPersistence();
      store.markCleanShutdown();
      await store.flush();
      expect(fs.existsSync(path.join(storage.root, "bot-storage.json"))).toBe(false);
      await closeOpenClawStateDatabaseAsync();
      const restored = await openStore();
      expect(restored.hasSavedSyncFromCleanShutdown()).toBe(true);
      expect(restored.getSyncToken()).toBe("worker-cursor");
      await restored.deleteAllData();
      await restored.freezeSyncCursorPersistence();
      await closeOpenClawStateDatabaseAsync();
      const deleted = await openStore();
      expect(deleted.hasSavedSync()).toBe(false);
      expect(deleted.getSyncToken()).toBeNull();
      for (const method of observation.calls) {
        expect(method).not.toHaveBeenCalled();
      }
    } finally {
      observation.restore();
    }
  });

  it("keeps a cache generation intact while another store instance publishes", async () => {
    const runtime = getMatrixRuntime();
    const openKeyedStore = runtime.state.openKeyedStoreV2.bind(runtime.state);
    const metadataRead = createDeferred<void>();
    const releaseRead = createDeferred<void>();
    const writeStarted = vi.fn();
    let pauseReads = false;
    vi.spyOn(runtime.state, "openKeyedStoreV2").mockImplementation((options) => {
      const store = openKeyedStore(options);
      if (options.namespace !== "sync-cache") {
        return store;
      }
      return {
        ...store,
        lookup: async (key) => {
          const value = await store.lookup(key);
          if (pauseReads && key === "current:meta") {
            metadataRead.resolve();
            await releaseRead.promise;
          }
          return value;
        },
        register: async (...args) => {
          writeStarted();
          return store.register(...args);
        },
      };
    });
    const writer = await seededStore("previous-generation", true);
    writeStarted.mockClear();
    pauseReads = true;
    const reading = SqliteBackedMatrixSyncStore.create(`${storage.root}/.`);
    await metadataRead.promise;
    await writer.setSyncData(createSyncResponse("next-generation"));
    const writing = writer.flush();
    try {
      await setImmediate();
      const interleaved = writeStarted.mock.calls.length > 0;
      // Let an incorrectly admitted writer retire the old chunks before the read resumes.
      if (interleaved) {
        await writing;
      }
      releaseRead.resolve();
      const restored = await reading;
      await writing;
      expect(restored.getSyncToken()).toBe("previous-generation");
      expect(restored.hasSavedSyncFromCleanShutdown()).toBe(true);
      expect(interleaved).toBe(false);
      const latest = await openStore();
      expect(latest.getSyncToken()).toBe("next-generation");
      expect(latest.hasSavedSyncFromCleanShutdown()).toBe(false);
    } finally {
      releaseRead.resolve();
      await Promise.allSettled([reading, writing]);
    }
  });

  it("joins deletion before freezing or persisting newer sync data", async () => {
    const runtime = getMatrixRuntime();
    const openKeyedStore = runtime.state.openKeyedStoreV2.bind(runtime.state);
    const deleting = createDeferred<void>();
    const release = createDeferred<void>();
    vi.spyOn(runtime.state, "openKeyedStoreV2").mockImplementation((options) => {
      const store = openKeyedStore(options);
      return {
        ...store,
        delete: async (key) => {
          if (key === "current:meta") {
            deleting.resolve();
            await release.promise;
          }
          return store.delete(key);
        },
      };
    });
    const store = await seededStore("old");
    const deletion = store.deleteAllData();
    await deleting.promise;
    await store.setSyncData(createSyncResponse("new"));
    const flush = store.flush();
    let frozen = false;
    const freeze = store.freezeSyncCursorPersistence().then(() => {
      frozen = true;
    });
    await Promise.resolve();
    expect(frozen).toBe(false);
    release.resolve();
    await Promise.all([deletion, flush, freeze]);
    const restored = await openStore();
    expect(restored.getSyncToken()).toBe("new");
  });

  it("restores multi-chunk sync data and rejects a bad digest with lookup-only stores", async () => {
    const response = createSyncResponse("large-cursor");
    response.account_data.events.push({
      type: "com.openclaw.large",
      content: { value: "🦞".repeat(100_000) },
    });
    const writer = await openStore();
    await writer.setSyncData(structuredClone(response));
    await writer.flush();
    const room = response.rooms.join?.["!room:example.org"];
    assert(room);
    room["org.matrix.msc4222.state_after"] = { events: [] };
    const expected = {
      nextBatch: "large-cursor",
      accountData: response.account_data.events,
      roomsData: response.rooms,
    };
    const restored = await openStore();
    await expect(restored.getSavedSync()).resolves.toEqual(expected);
    const sync = syncCache();
    const asyncStore = asyncCache();
    const asyncReader = { lookup: (key: string) => asyncStore.lookup(key) };
    const readParams = { storageRootDir: storage.root, store: asyncReader };
    expect((await readPersistedStoreFromStore(readParams))?.savedSync).toEqual(expected);
    await expect(hasMatrixSyncCacheStateInStore(readParams)).resolves.toBe(true);
    const chunk = sync
      .entries()
      .find((row) => row.value.kind === "sync-chunk" && row.value.index === 10);
    if (!chunk || chunk.value.kind !== "sync-chunk") {
      throw new Error("expected sync chunk 10");
    }
    sync.register(chunk.key, { ...chunk.value, data: "modified" });
    expect(await readPersistedStoreFromStore(readParams)).toMatchObject(invalidCache);
    await expect(hasMatrixSyncCacheStateInStore(readParams)).resolves.toBe(false);
  });

  it("validates selected chunk JSON after earlier gaps with bulk stores", async () => {
    const options = cacheOptions();
    const { db } = openOpenClawStateDatabase({ env: options.env });
    // Seed corrupt bytes before the runtime publishes any cached chunk facts.
    const insert = db.prepare(
      "INSERT INTO plugin_state_entries (plugin_id, namespace, entry_key, value_json, created_at, expires_at) VALUES ('matrix', 'sync-cache', ?, ?, 1, NULL)",
    );
    insert.run(
      "current:meta",
      JSON.stringify({ kind: "meta", version: 1, generation: "corrupt", chunkCount: 2 }),
    );
    insert.run("current:sync:corrupt:1", "invalid JSON");
    const sync = syncCache();
    const readParams = { storageRootDir: storage.root, store: asyncCache() };
    const firstKey = "current:sync:corrupt:0";
    for (const early of ["invalid", "missing"]) {
      if (early === "invalid") {
        sync.register(firstKey, { kind: "sync-chunk", index: -1, data: "" });
      } else {
        sync.delete(firstKey);
      }
      expect(await readPersistedStoreFromStore(readParams)).toMatchObject(invalidCache);
      await expect(hasMatrixSyncCacheStateInStore(readParams)).resolves.toBe(false);
    }
    sync.register(firstKey, { kind: "sync-chunk", index: 0, data: "" });
    await expect(readPersistedStoreFromStore(readParams)).rejects.toMatchObject({
      code: "PLUGIN_STATE_CORRUPT",
    });
    await expect(hasMatrixSyncCacheStateInStore(readParams)).rejects.toMatchObject({
      code: "PLUGIN_STATE_CORRUPT",
    });
  });

  it("ignores metadata with impossible chunk counts", async () => {
    syncCache().register("current:meta", {
      kind: "meta",
      version: 1,
      generation: "corrupt",
      chunkCount: 20_000,
      cleanShutdown: true,
    });

    const syncStore = await openStore();
    expect(syncStore.hasSavedSync()).toBe(false);
    await expect(syncStore.getSavedSyncToken()).resolves.toBe(null);
  });

  it("fails persistence instead of silently dropping sync data when sqlite is unavailable", async () => {
    vi.spyOn(getMatrixRuntime().state, "openKeyedStoreV2").mockImplementation(() => {
      throw new Error("sqlite unavailable");
    });

    const syncStore = await openStore();
    await syncStore.setSyncData(createSyncResponse("unavailable-token"));

    await expect(syncStore.flush()).rejects.toThrow(/sqlite store is unavailable/i);
  });

  it("claims current-token storage ownership when sync state is persisted", async () => {
    const metadata = createPluginStateSyncKeyedStoreForTests<Record<string, unknown>>(
      "matrix",
      openMatrixStorageMetaStoreOptions(storage.root),
    );
    metadata.register("current", { accessTokenHash: "token-hash", deviceId: null });
    await seededStore("claimed-token");
    expect(metadata.lookup("current")).toMatchObject({ currentTokenStateClaimed: true });
  });

  it.each([false, true])("freezes the admitted cursor with discard=%s", async (discard) => {
    const store = await openStore();
    await store.setSyncData(createSyncResponse("before-freeze"));
    await store.freezeSyncCursorPersistence();
    if (discard) {
      store.discardPendingSyncCursorPersistence();
    } else {
      await store.setSyncData(createSyncResponse("after-freeze"));
      store.markCleanShutdown();
    }
    await store.flush();
    const persisted = await openStore();
    expect(persisted.hasSavedSync()).toBe(!discard);
    await expect(persisted.getSavedSyncToken()).resolves.toBe(discard ? null : "before-freeze");
    expect(persisted.hasSavedSyncFromCleanShutdown()).toBe(!discard);
  });

  it("coalesces background persistence until the debounce window elapses", async () => {
    vi.useFakeTimers();
    const store = await openStore();
    await store.setSyncData(createSyncResponse("s111"));
    await store.setSyncData(createSyncResponse("s222"));
    await store.storeClientOptions({ lazyLoadMembers: true });
    expect((await openStore()).hasSavedSync()).toBe(false);
    await vi.advanceTimersByTimeAsync(249);
    expect((await openStore()).hasSavedSync()).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await Promise.resolve();
    await store.flush();
    const persisted = await openStore();
    expect(persisted.hasSavedSync()).toBe(true);
    await expect(persisted.getSavedSyncToken()).resolves.toBe("s222");
    await expect(persisted.getClientOptions()).resolves.toEqual({ lazyLoadMembers: true });
  });
});
