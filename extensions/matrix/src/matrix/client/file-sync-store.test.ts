import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { ClientEvent, createClient, type ISyncResponse } from "matrix-js-sdk/lib/matrix.js";
import { RustCrypto } from "matrix-js-sdk/lib/rust-crypto/rust-crypto.js";
import { SyncState } from "matrix-js-sdk/lib/sync.js";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  resetPluginStateStoreForTests,
  createPluginStateKeyedStoreForTests,
  openOpenClawStateDatabase,
  createPluginStateSyncKeyedStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { describe, expect, it, vi } from "vitest";
import { getMatrixRuntime } from "../../runtime.js";
import { MatrixClient } from "../sdk.js";
import { SqliteBackedMatrixSyncStore } from "./file-sync-store.js";
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
const userId = "@recipient:example.org";
const roomId = "!verification:example.org";
const cachedEventId = "$completed-verification";
const liveEventId = "$fresh-verification";
function verificationSync(nextBatch: string, eventId: string): ISyncResponse {
  const event = {
    event_id: eventId,
    sender: "@sender:example.org",
    origin_server_ts: 1,
    type: "m.room.message",
    content: {
      msgtype: "m.key.verification.request",
      body: "Verification request",
      to: userId,
      from_device: "SENDER",
      methods: ["m.sas.v1"],
    },
  };
  return matrixSyncResponse(nextBatch, roomId, event, "pagination-cursor");
}
async function ingressFixture(root: string) {
  const store = await SqliteBackedMatrixSyncStore.create(root);
  const client = new MatrixClient("https://example.org", "fixture-token", { syncStore: store });
  return { store, client, entered: createDeferred<void>(), release: createDeferred<void>() };
}
async function expectCursor(root: string, store: SqliteBackedMatrixSyncStore, token: string) {
  await store.flush();
  expect(store.getSyncToken()).toBe(token);
  await expect((await SqliteBackedMatrixSyncStore.create(root)).getSavedSyncToken()).resolves.toBe(
    token,
  );
}
describe("Matrix SDK sync-cache verification routing", () => {
  const storage = useSyncStoreFixture("openclaw-matrix-sync-sdk-", true);
  it.each([false, true])("routes live crypto: cache=%s", async (hasCache) => {
    if (hasCache) {
      const seed = await SqliteBackedMatrixSyncStore.create(storage.root);
      await seed.setSyncData(verificationSync("saved-cursor", cachedEventId));
      seed.markCleanShutdown();
      await seed.flush();
      await closeOpenClawStateDatabaseAsync();
      resetPluginStateStoreForTests();
    }
    const store = await SqliteBackedMatrixSyncStore.create(storage.root);
    expect(store.hasSavedSyncFromCleanShutdown()).toBe(hasCache);
    await expect(store.getSavedSyncToken()).resolves.toBe(hasCache ? "saved-cursor" : null);
    const cachedPrepared = createDeferred<void>();
    if (!hasCache) {
      cachedPrepared.resolve();
    }
    const stopped = createDeferred<void>();
    const failed = createDeferred<never>();
    const events: Array<string | undefined> = [];
    const syncRequests: Array<string | null> = [];
    const unexpectedRequests: string[] = [];
    const fetchFixture: typeof fetch = async (input) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      expect(url.origin).toBe("https://example.org");
      const endpoint = url.pathname;
      if (endpoint === "/.well-known/matrix/client") {
        return Response.json({}, { status: 404 });
      }
      const fixtures: Record<string, unknown> = {
        "/versions": { versions: ["v1.11"], unstable_features: {} },
        "/capabilities": { capabilities: {} },
        "/pushrules/": {
          global: { override: [], content: [], room: [], sender: [], underride: [] },
        },
        "/filter": { filter_id: "fixture-filter" },
        "/keys/upload": { one_time_key_counts: { signed_curve25519: 100 } },
        "/keys/query": { device_keys: {}, failures: {} },
      };
      const fixture = Object.entries(fixtures).find(([suffix]) => endpoint.endsWith(suffix));
      if (fixture) {
        return Response.json(fixture[1]);
      }
      if (endpoint.endsWith("/rtc/transports") || endpoint.endsWith("/room_keys/version")) {
        return Response.json({ errcode: "M_NOT_FOUND", error: "Not configured" }, { status: 404 });
      }
      if (endpoint.endsWith("/sync")) {
        syncRequests.push(url.searchParams.get("since"));
        await cachedPrepared.promise;
        return Response.json(verificationSync("fresh-cursor", liveEventId));
      }
      unexpectedRequests.push(endpoint);
      const error = new Error(`Unexpected fixture request: ${endpoint}`);
      failed.reject(error);
      throw error;
    };
    // AutoDiscovery uses global fetch independently of the client fetch option.
    vi.stubGlobal("fetch", fetchFixture);
    const client = createClient({
      baseUrl: "https://example.org",
      userId,
      deviceId: "RECIPIENT",
      accessToken: "test-token",
      fetchFn: fetchFixture,
      store,
    });
    // Keep real client, Rust initialization and sync wiring; observe only the
    // verification boundary so the test does not invent peer crypto responses.
    const cryptoInput = vi
      .spyOn(RustCrypto.prototype, "onLiveEventFromSync")
      .mockResolvedValue(undefined);
    client.on(ClientEvent.Event, (event) => events.push(event.getId()));
    client.on(ClientEvent.SyncUnexpectedError, (error) => failed.reject(error));
    client.on(ClientEvent.Sync, (state, _previous, data) => {
      if (state === SyncState.Prepared && data?.fromCache) {
        cachedPrepared.resolve();
      }
      if (state === SyncState.Syncing) {
        client.stopClient();
      }
      if (state === SyncState.Stopped) {
        stopped.resolve();
      }
    });
    let started = false;
    try {
      await client.initRustCrypto({ useIndexedDB: false });
      await client.startClient();
      started = true;
      await Promise.race([stopped.promise, failed.promise]);
      expect(unexpectedRequests).toEqual([]);
      expect(syncRequests).toEqual([hasCache ? "saved-cursor" : null]);
      expect(events).toEqual(hasCache ? [cachedEventId, liveEventId] : [liveEventId]);
      expect(
        client
          .getRoom(roomId)
          ?.getLiveTimeline()
          .getEvents()
          .map((event) => event.getId()),
      ).toEqual(events);
      expect(store.getSyncToken()).toBe("fresh-cursor");
      expect(cryptoInput.mock.calls.map(([event]) => event.getId())).toEqual([liveEventId]);
    } finally {
      client.stopClient();
      if (started) {
        await stopped.promise;
      }
      await store.flush();
    }
  });
});
describe("Matrix sync ingress admission", () => {
  const storage = useSyncStoreFixture("openclaw-matrix-sync-ingress-");
  it("holds the cursor until admission and reports failure without losing the previous cursor", async () => {
    const { store, client, entered, release } = await ingressFixture(storage.root);
    const failure = new Error("ingress storage unavailable");
    const errors: Error[] = [];
    const savedSyncContexts: boolean[] = [];
    client.on("sync.unexpected_error", (error) => errors.push(error));
    const dispose = await client.bindSyncIngress(async (sync, { hasSavedSync }) => {
      savedSyncContexts.push(hasSavedSync);
      if (sync.next_batch === "rejected-cursor") {
        throw failure;
      }
      entered.resolve();
      await release.promise;
    });
    let pending: Promise<void> | undefined;
    try {
      // Classic sync assigns its speculative token before invoking setSyncData.
      store.setSyncToken("accepted-cursor");
      pending = store.setSyncData(verificationSync("accepted-cursor", liveEventId));
      await entered.promise;
      await store.flush();
      expect(store.getSyncToken()).toBeNull();
      expect((await SqliteBackedMatrixSyncStore.create(storage.root)).hasSavedSync()).toBe(false);
      release.resolve();
      await pending;
      await expectCursor(storage.root, store, "accepted-cursor");
      store.setSyncToken("rejected-cursor");
      await expect(
        store.setSyncData(verificationSync("rejected-cursor", "$rejected")),
      ).rejects.toBe(failure);
      await expectCursor(storage.root, store, "accepted-cursor");
      expect(savedSyncContexts).toEqual([false, false]);
      expect(errors).toEqual([failure]);
    } finally {
      release.resolve();
      await pending;
      dispose();
      await client.stopWithoutPersist();
    }
  });
  it("joins an admitted write during shutdown without publishing its frozen cursor", async () => {
    const seed = await SqliteBackedMatrixSyncStore.create(storage.root);
    await seed.setSyncData(verificationSync("previous-cursor", cachedEventId));
    seed.setSyncToken("previous-cursor");
    await seed.flush();
    const { store, client, entered, release } = await ingressFixture(storage.root);
    const admittedBatches: string[] = [];
    const dispose = await client.bindSyncIngress(async (sync, { hasSavedSync }) => {
      admittedBatches.push(sync.next_batch);
      expect(hasSavedSync).toBe(true);
      if (sync.next_batch === "previous-cursor") {
        return;
      }
      entered.resolve();
      await release.promise;
    });
    let pending: Promise<void> | undefined;
    let freeze: Promise<void> | undefined;
    try {
      store.setSyncToken("shutdown-cursor");
      pending = store.setSyncData(verificationSync("shutdown-cursor", liveEventId));
      await entered.promise;
      let frozen = false;
      freeze = store.freezeSyncCursorPersistence().then(() => {
        frozen = true;
      });
      await Promise.resolve();
      expect(frozen).toBe(false);
      release.resolve();
      await Promise.all([pending, freeze]);
      store.markCleanShutdown();
      await expectCursor(storage.root, store, "previous-cursor");
      expect(admittedBatches).toEqual(["previous-cursor", "shutdown-cursor"]);
    } finally {
      release.resolve();
      await Promise.all([pending, freeze]);
      dispose();
      await client.stopWithoutPersist();
    }
  });
});
