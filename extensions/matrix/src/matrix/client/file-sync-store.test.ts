import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import type { ISyncResponse } from "matrix-js-sdk/lib/matrix.js";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  createPluginStateKeyedStoreForTests,
  openOpenClawStateDatabase,
  createPluginStateSyncKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import {
  closeOpenClawStateDatabaseAsync,
  observeHostDataSql,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getMatrixRuntime } from "../../runtime.js";
import { installMatrixTestRuntime } from "../../test-runtime.js";
import { SqliteBackedMatrixSyncStore } from "./file-sync-store.js";
import { openMatrixStorageMetaStoreOptions } from "./storage-metadata.js";
import {
  hasMatrixSyncCacheStateInStore,
  readPersistedStoreFromStore,
  openMatrixSyncCacheStoreOptions,
  type MatrixSyncCacheRecord,
} from "./sync-cache-state.js";

function createSyncResponse(nextBatch: string): ISyncResponse {
  return {
    next_batch: nextBatch,
    rooms: {
      join: {
        "!room:example.org": {
          summary: {
            "m.heroes": [],
          },
          state: { events: [] },
          timeline: {
            events: [
              {
                content: {
                  body: "hello",
                  msgtype: "m.text",
                },
                event_id: "$message",
                origin_server_ts: 1,
                sender: "@user:example.org",
                type: "m.room.message",
              },
            ],
            prev_batch: "t0",
          },
          ephemeral: { events: [] },
          account_data: { events: [] },
          unread_notifications: {},
        },
      },
      invite: {},
      leave: {},
      knock: {},
    },
    account_data: {
      events: [
        {
          content: { theme: "dark" },
          type: "com.openclaw.test",
        },
      ],
    },
  };
}

describe("SqliteBackedMatrixSyncStore", () => {
  const tempDirs: string[] = [];

  function createStorageRoot(): string {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-matrix-sync-store-"));
    tempDirs.push(tempDir);
    return tempDir;
  }

  beforeEach(() => {
    resetPluginStateStoreForTests();
    installMatrixTestRuntime();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    await closeOpenClawStateDatabaseAsync();
    resetPluginStateStoreForTests();
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("persists sync data so restart resumes from the saved cursor", async () => {
    const storageRoot = createStorageRoot();
    const syncResponse = createSyncResponse("s123");

    const firstStore = await SqliteBackedMatrixSyncStore.create(storageRoot);
    expect(firstStore.hasSavedSync()).toBe(false);
    await firstStore.setSyncData(structuredClone(syncResponse));
    await firstStore.flush();
    expect(fs.existsSync(path.join(storageRoot, "bot-storage.json"))).toBe(false);

    const secondStore = await SqliteBackedMatrixSyncStore.create(storageRoot);
    expect(secondStore.hasSavedSync()).toBe(true);
    await expect(secondStore.getSavedSyncToken()).resolves.toBe("s123");

    const savedSync = await secondStore.getSavedSync();
    expect(savedSync).toEqual({
      nextBatch: "s123",
      accountData: syncResponse.account_data.events,
      roomsData: {
        join: {
          "!room:example.org": {
            ...syncResponse.rooms.join["!room:example.org"],
            "org.matrix.msc4222.state_after": { events: [] },
          },
        },
        invite: {},
        leave: {},
        knock: {},
      },
    });
    expect(secondStore.hasSavedSyncFromCleanShutdown()).toBe(false);
  });

  it("loads, persists, deletes and closes the sync cache without host SQLite", async () => {
    const storageRoot = createStorageRoot();
    const observation = observeHostDataSql(openMatrixSyncCacheStoreOptions(storageRoot).env);
    const sql = observation.calls;
    const timings: Record<string, number> = {};
    try {
      let started = performance.now();
      const store = await SqliteBackedMatrixSyncStore.create(storageRoot);
      timings.coldLoadMs = performance.now() - started;
      expect(store.hasSavedSync()).toBe(false);
      expect(fs.existsSync(path.join(storageRoot, "state", "openclaw.sqlite"))).toBe(false);
      await store.setSyncData(createSyncResponse("worker-cursor"));
      await store.freezeSyncCursorPersistence();
      store.markCleanShutdown();
      started = performance.now();
      await store.flush();
      timings.persistMs = performance.now() - started;
      await closeOpenClawStateDatabaseAsync();
      started = performance.now();
      const restored = await SqliteBackedMatrixSyncStore.create(storageRoot);
      timings.coldRestoreMs = performance.now() - started;
      expect(restored.hasSavedSyncFromCleanShutdown()).toBe(true);
      expect(restored.getSyncToken()).toBe("worker-cursor");
      started = performance.now();
      await restored.deleteAllData();
      timings.deleteMs = performance.now() - started;
      await restored.freezeSyncCursorPersistence();
      await closeOpenClawStateDatabaseAsync();
      const deleted = await SqliteBackedMatrixSyncStore.create(storageRoot);
      expect(deleted.hasSavedSync()).toBe(false);
      expect(deleted.getSyncToken()).toBeNull();
      for (const method of sql) {
        expect(method).not.toHaveBeenCalled();
      }
      console.log("matrix-sync-cache-worker timings", JSON.stringify(timings));
    } finally {
      observation.restore();
    }
  });

  it("keeps a cache generation intact while another store instance publishes", async () => {
    const storageRoot = createStorageRoot();
    const runtime = getMatrixRuntime();
    const openStore = runtime.state.openKeyedStore.bind(runtime.state);
    const metadataRead = createDeferred<void>();
    const releaseRead = createDeferred<void>();
    const writeStarted = vi.fn();
    let pauseReads = false;
    vi.spyOn(runtime.state, "openKeyedStore").mockImplementation((options) => {
      const store = openStore(options);
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
    const writer = await SqliteBackedMatrixSyncStore.create(storageRoot);
    await writer.setSyncData(createSyncResponse("previous-generation"));
    writer.markCleanShutdown();
    await writer.flush();
    writeStarted.mockClear();
    pauseReads = true;
    const reading = SqliteBackedMatrixSyncStore.create(`${storageRoot}/.`);
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
      const latest = await SqliteBackedMatrixSyncStore.create(storageRoot);
      expect(latest.getSyncToken()).toBe("next-generation");
    } finally {
      releaseRead.resolve();
      await Promise.allSettled([reading, writing]);
    }
  });

  it("joins deletion before freezing or persisting newer sync data", async () => {
    const storageRoot = createStorageRoot();
    const runtime = getMatrixRuntime();
    const openStore = runtime.state.openKeyedStore.bind(runtime.state);
    const deleting = createDeferred<void>();
    const release = createDeferred<void>();
    vi.spyOn(runtime.state, "openKeyedStore").mockImplementation((options) => {
      const store = openStore(options);
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
    const store = await SqliteBackedMatrixSyncStore.create(storageRoot);
    await store.setSyncData(createSyncResponse("old"));
    await store.flush();
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
    const restored = await SqliteBackedMatrixSyncStore.create(storageRoot);
    expect(restored.getSyncToken()).toBe("new");
  });

  it.each(["bulk", "legacy"])(
    "restores multi-chunk sync data and rejects a bad digest with %s stores",
    async (mode) => {
      const storageRoot = createStorageRoot();
      const response = createSyncResponse("large-cursor");
      response.account_data.events.push({
        type: "com.openclaw.large",
        content: { value: "🦞".repeat(100_000) },
      });
      const writer = await SqliteBackedMatrixSyncStore.create(storageRoot);
      await writer.setSyncData(response);
      await writer.flush();
      const expected = await writer.getSavedSync();
      const options = openMatrixSyncCacheStoreOptions(storageRoot);
      const sync = createPluginStateSyncKeyedStoreForTests<MatrixSyncCacheRecord>(
        "matrix",
        options,
      );
      const asyncStore = createPluginStateKeyedStoreForTests<MatrixSyncCacheRecord>(
        "matrix",
        options,
      );
      const asyncReader =
        mode === "bulk" ? asyncStore : { lookup: (key: string) => asyncStore.lookup(key) };
      expect(
        (await readPersistedStoreFromStore({ storageRootDir: storageRoot, store: asyncReader }))
          ?.savedSync,
      ).toEqual(expected);
      await expect(
        hasMatrixSyncCacheStateInStore({ storageRootDir: storageRoot, store: asyncReader }),
      ).resolves.toBe(true);
      const chunk = sync
        .entries()
        .find((row) => row.value.kind === "sync-chunk" && row.value.index === 10);
      if (!chunk || chunk.value.kind !== "sync-chunk") {
        throw new Error("expected sync chunk 10");
      }
      sync.register(chunk.key, { ...chunk.value, data: "modified" });
      expect(
        await readPersistedStoreFromStore({ storageRootDir: storageRoot, store: asyncReader }),
      ).toMatchObject({
        savedSync: null,
        cleanShutdown: false,
      });
      await expect(
        hasMatrixSyncCacheStateInStore({ storageRootDir: storageRoot, store: asyncReader }),
      ).resolves.toBe(false);
      const laterChunk = sync
        .entries()
        .find((row) => row.value.kind === "sync-chunk" && row.value.index === 11);
      if (!laterChunk) {
        throw new Error("expected sync chunk 11");
      }
      const { db } = openOpenClawStateDatabase({ env: options.env });
      db.prepare("UPDATE plugin_state_entries SET value_json = ? WHERE entry_key = ?").run(
        "invalid JSON",
        laterChunk.key,
      );
      for (const early of ["invalid", "missing"]) {
        if (early === "invalid") {
          sync.register(chunk.key, { ...chunk.value, index: -1 });
        } else {
          sync.delete(chunk.key);
        }
        expect(
          await readPersistedStoreFromStore({ storageRootDir: storageRoot, store: asyncReader }),
        ).toMatchObject({
          savedSync: null,
          cleanShutdown: false,
        });
        await expect(
          hasMatrixSyncCacheStateInStore({ storageRootDir: storageRoot, store: asyncReader }),
        ).resolves.toBe(false);
      }
      sync.register(chunk.key, chunk.value);
      await expect(
        readPersistedStoreFromStore({ storageRootDir: storageRoot, store: asyncReader }),
      ).rejects.toMatchObject({
        code: "PLUGIN_STATE_CORRUPT",
      });
      await expect(
        hasMatrixSyncCacheStateInStore({ storageRootDir: storageRoot, store: asyncReader }),
      ).rejects.toMatchObject({ code: "PLUGIN_STATE_CORRUPT" });
    },
  );

  it("restores the sync cache after the storage root moves", async () => {
    const storageRoot = createStorageRoot();
    const movedStorageRoot = `${storageRoot}-moved`;

    const firstStore = await SqliteBackedMatrixSyncStore.create(storageRoot);
    await firstStore.setSyncData(createSyncResponse("portable-token"));
    await firstStore.flush();
    await closeOpenClawStateDatabaseAsync();
    resetPluginStateStoreForTests();
    fs.renameSync(storageRoot, movedStorageRoot);
    tempDirs.push(movedStorageRoot);

    const secondStore = await SqliteBackedMatrixSyncStore.create(movedStorageRoot);
    expect(secondStore.hasSavedSync()).toBe(true);
    await expect(secondStore.getSavedSyncToken()).resolves.toBe("portable-token");
  });

  it("ignores metadata with impossible chunk counts", async () => {
    const storageRoot = createStorageRoot();
    const store = createPluginStateSyncKeyedStoreForTests<MatrixSyncCacheRecord>(
      "matrix",
      openMatrixSyncCacheStoreOptions(storageRoot),
    );
    store.register("current:meta", {
      kind: "meta",
      version: 1,
      generation: "corrupt",
      chunkCount: 20_000,
      cleanShutdown: true,
    });

    const syncStore = await SqliteBackedMatrixSyncStore.create(storageRoot);
    expect(syncStore.hasSavedSync()).toBe(false);
    await expect(syncStore.getSavedSyncToken()).resolves.toBe(null);
  });

  it("fails persistence instead of silently dropping sync data when sqlite is unavailable", async () => {
    const storageRoot = createStorageRoot();
    const runtime = getMatrixRuntime();
    vi.spyOn(runtime.state, "openKeyedStore").mockImplementation(() => {
      throw new Error("sqlite unavailable");
    });

    const syncStore = await SqliteBackedMatrixSyncStore.create(storageRoot);
    await syncStore.setSyncData(createSyncResponse("unavailable-token"));

    await expect(syncStore.flush()).rejects.toThrow(/sqlite store is unavailable/i);
  });

  it("claims current-token storage ownership when sync state is persisted", async () => {
    const storageRoot = createStorageRoot();
    createPluginStateSyncKeyedStoreForTests<Record<string, unknown>>(
      "matrix",
      openMatrixStorageMetaStoreOptions(storageRoot),
    ).register("current", {
      homeserver: "https://matrix.example.org",
      userId: "@bot:example.org",
      accountId: "default",
      accessTokenHash: "token-hash",
      deviceId: null,
    });

    const store = await SqliteBackedMatrixSyncStore.create(storageRoot);
    await store.setSyncData(createSyncResponse("claimed-token"));
    await store.flush();

    const meta = createPluginStateSyncKeyedStoreForTests<Record<string, unknown>>(
      "matrix",
      openMatrixStorageMetaStoreOptions(storageRoot),
    ).lookup("current");
    expect(meta).toMatchObject({ currentTokenStateClaimed: true });
  });

  it("only treats sync state as restart-safe after a clean shutdown persist", async () => {
    const storageRoot = createStorageRoot();

    const firstStore = await SqliteBackedMatrixSyncStore.create(storageRoot);
    await firstStore.setSyncData(createSyncResponse("s123"));
    await firstStore.flush();

    const afterDirtyPersist = await SqliteBackedMatrixSyncStore.create(storageRoot);
    expect(afterDirtyPersist.hasSavedSync()).toBe(true);
    expect(afterDirtyPersist.hasSavedSyncFromCleanShutdown()).toBe(false);

    firstStore.markCleanShutdown();
    await firstStore.flush();

    const afterCleanShutdown = await SqliteBackedMatrixSyncStore.create(storageRoot);
    expect(afterCleanShutdown.hasSavedSync()).toBe(true);
    expect(afterCleanShutdown.hasSavedSyncFromCleanShutdown()).toBe(true);
  });

  it("clears the clean-shutdown marker once fresh sync data arrives", async () => {
    const storageRoot = createStorageRoot();

    const firstStore = await SqliteBackedMatrixSyncStore.create(storageRoot);
    await firstStore.setSyncData(createSyncResponse("s123"));
    firstStore.markCleanShutdown();
    await firstStore.flush();

    const restartedStore = await SqliteBackedMatrixSyncStore.create(storageRoot);
    expect(restartedStore.hasSavedSyncFromCleanShutdown()).toBe(true);

    await restartedStore.setSyncData(createSyncResponse("s456"));
    await restartedStore.flush();

    const afterNewSync = await SqliteBackedMatrixSyncStore.create(storageRoot);
    expect(afterNewSync.hasSavedSync()).toBe(true);
    expect(afterNewSync.hasSavedSyncFromCleanShutdown()).toBe(false);
    await expect(afterNewSync.getSavedSyncToken()).resolves.toBe("s456");
  });

  it("freezes the last admitted cursor and marks only that cursor clean", async () => {
    const storageRoot = createStorageRoot();
    const store = await SqliteBackedMatrixSyncStore.create(storageRoot);

    await store.setSyncData(createSyncResponse("before-freeze"));
    await store.freezeSyncCursorPersistence();
    await store.setSyncData(createSyncResponse("after-freeze"));
    store.markCleanShutdown();
    await store.flush();

    const persisted = await SqliteBackedMatrixSyncStore.create(storageRoot);
    await expect(persisted.getSavedSyncToken()).resolves.toBe("before-freeze");
    expect(persisted.hasSavedSyncFromCleanShutdown()).toBe(true);
  });

  it("waits for an in-flight pre-freeze persist before freezing the cursor", async () => {
    const storageRoot = createStorageRoot();
    const store = await SqliteBackedMatrixSyncStore.create(storageRoot);

    await store.setSyncData(createSyncResponse("in-flight"));
    const flush = store.flush();
    const freeze = store.freezeSyncCursorPersistence();
    await Promise.all([flush, freeze]);
    store.markCleanShutdown();
    await store.flush();

    const persisted = await SqliteBackedMatrixSyncStore.create(storageRoot);
    await expect(persisted.getSavedSyncToken()).resolves.toBe("in-flight");
    expect(persisted.hasSavedSyncFromCleanShutdown()).toBe(true);
  });

  it("discards pending cursor writes without marking a poisoned shutdown clean", async () => {
    const storageRoot = createStorageRoot();
    const store = await SqliteBackedMatrixSyncStore.create(storageRoot);

    await store.setSyncData(createSyncResponse("suspect"));
    await store.freezeSyncCursorPersistence();
    store.discardPendingSyncCursorPersistence();
    await store.flush();

    const persisted = await SqliteBackedMatrixSyncStore.create(storageRoot);
    expect(persisted.hasSavedSync()).toBe(false);
    expect(persisted.hasSavedSyncFromCleanShutdown()).toBe(false);
  });

  it("coalesces background persistence until the debounce window elapses", async () => {
    vi.useFakeTimers();
    const storageRoot = createStorageRoot();

    const store = await SqliteBackedMatrixSyncStore.create(storageRoot);
    await store.setSyncData(createSyncResponse("s111"));
    await store.setSyncData(createSyncResponse("s222"));
    await store.storeClientOptions({ lazyLoadMembers: true });

    const beforeDebounce = await SqliteBackedMatrixSyncStore.create(storageRoot);
    expect(beforeDebounce.hasSavedSync()).toBe(false);

    await vi.advanceTimersByTimeAsync(249);
    const beforeElapsed = await SqliteBackedMatrixSyncStore.create(storageRoot);
    expect(beforeElapsed.hasSavedSync()).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await Promise.resolve();
    await store.flush();

    const persisted = await SqliteBackedMatrixSyncStore.create(storageRoot);
    expect(persisted.hasSavedSync()).toBe(true);
    await expect(persisted.getSavedSyncToken()).resolves.toBe("s222");
    await expect(persisted.getClientOptions()).resolves.toEqual({ lazyLoadMembers: true });
  });

  it("persists client options alongside sync state", async () => {
    const storageRoot = createStorageRoot();

    const firstStore = await SqliteBackedMatrixSyncStore.create(storageRoot);
    await firstStore.storeClientOptions({ lazyLoadMembers: true });
    await firstStore.flush();

    const secondStore = await SqliteBackedMatrixSyncStore.create(storageRoot);
    await expect(secondStore.getClientOptions()).resolves.toEqual({ lazyLoadMembers: true });
  });

  it("ignores legacy raw sync cache files", async () => {
    const storageRoot = createStorageRoot();

    fs.writeFileSync(
      path.join(storageRoot, "bot-storage.json"),
      JSON.stringify({
        next_batch: "legacy-token",
        rooms: {
          join: {},
        },
        account_data: {
          events: [],
        },
      }),
      "utf8",
    );

    const store = await SqliteBackedMatrixSyncStore.create(storageRoot);
    expect(store.hasSavedSync()).toBe(false);
    await expect(store.getSavedSyncToken()).resolves.toBe(null);
  });
});
