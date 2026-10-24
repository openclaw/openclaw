import path from "node:path";
import { setImmediate } from "node:timers/promises";
import type { MatrixClient as MatrixJsSdkClient } from "matrix-js-sdk/lib/matrix.js";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { expect, it, vi, type MockInstance } from "vitest";
import { installMatrixTestRuntime } from "../../test-runtime.js";
import { SqliteBackedMatrixSyncStore } from "../client/file-sync-store.js";
import { readMatrixIdbSnapshotJson } from "../crypto-state-store.js";
import type { MatrixClient } from "../sdk.js";
import { clearAllIndexedDbState, seedDatabase } from "./idb-persistence.test-helpers.js";
import { LogService } from "./logger.js";

type CryptoPersistenceContext = {
  createSdkClient: (options: ConstructorParameters<typeof MatrixClient>[2]) => MatrixClient;
  getMatrixJsClient: () => Pick<MatrixJsSdkClient, "initRustCrypto" | "startClient" | "stopClient">;
  getSyncStore: () => unknown;
  clearMatrixSyncApiForNeverStartedClient: () => void;
  tempDirs: { make: (prefix: string) => string };
  expectAbortError: (promise: Promise<void>) => Promise<void>;
};

function createCryptoFixture(context: CryptoPersistenceContext, prefix?: string) {
  resetPluginStateStoreForTests();
  installMatrixTestRuntime();
  const tempDir = context.tempDirs.make("matrix-crypto-persistence-");
  const databasePrefix = prefix ?? path.basename(tempDir);
  return {
    tempDir,
    create: (syncStore?: SqliteBackedMatrixSyncStore) =>
      context.createSdkClient({
        encryption: true,
        cryptoDatabasePrefix: databasePrefix,
        idbSnapshotPath: path.join(tempDir, "crypto-idb-snapshot.json"),
        syncStore,
      }),
    seed: (value: string) =>
      seedDatabase({
        name: `${databasePrefix}::crypto`,
        storeName: "keys",
        records: [{ key: "session", value }],
      }),
    cleanup: async () => {
      await clearAllIndexedDbState({ databasePrefix });
      resetPluginStateStoreForTests();
    },
  };
}

export function registerCryptoShutdownTests(context: CryptoPersistenceContext): void {
  async function withCryptoStore(
    run: (fixture: {
      client: MatrixClient;
      tempDir: string;
      store: SqliteBackedMatrixSyncStore;
      databasesSpy: MockInstance<typeof indexedDB.databases>;
    }) => Promise<void>,
  ) {
    const fixture = createCryptoFixture(context);
    const { tempDir } = fixture;
    context.clearMatrixSyncApiForNeverStartedClient();
    const databasesSpy = vi.spyOn(indexedDB, "databases");
    let client: MatrixClient | undefined;
    try {
      const store = await SqliteBackedMatrixSyncStore.create(tempDir);
      client = fixture.create(store);
      await client.prepareForOneOff();
      await fixture.seed("fresh-key");
      expect(context.getSyncStore()).toBe(store);
      await run({ client, tempDir, store, databasesSpy });
    } finally {
      databasesSpy.mockRestore();
      await client?.stopWithoutPersist();
      await fixture.cleanup();
    }
  }

  it("persists crypto before marking and flushing the clean sync cursor", async () => {
    await withCryptoStore(async ({ client, tempDir, store, databasesSpy }) => {
      const cause = new Error("sync store flush failed");
      const pendingDatabases = createDeferred<IDBDatabaseInfo[]>();
      const dumping = createDeferred<void>();
      const flushSpy = vi.spyOn(store, "flush").mockRejectedValue(cause);
      const markCleanSpy = vi.spyOn(store, "markCleanShutdown");
      const databases = await indexedDB.databases();
      databasesSpy.mockImplementation(() => {
        dumping.resolve();
        return pendingDatabases.promise;
      });
      const shutdown = client.stopAndPersist();
      try {
        const rejected = expect(shutdown).rejects.toBe(cause);
        await dumping.promise;
        expect(markCleanSpy).not.toHaveBeenCalled();
        expect(flushSpy).not.toHaveBeenCalled();
        pendingDatabases.resolve(databases);
        await rejected;
        expect(await readMatrixIdbSnapshotJson(tempDir)).toContain("fresh-key");
        expect(markCleanSpy).toHaveBeenCalledTimes(1);
        expect(flushSpy).toHaveBeenCalledTimes(1);
        expect(vi.mocked(context.getMatrixJsClient()).stopClient).toHaveBeenCalledTimes(1);
      } finally {
        pendingDatabases.resolve([]);
        await shutdown.catch(() => undefined);
      }
    });
  });

  it("does not mark or flush the sync cursor when strict crypto persistence fails", async () => {
    await withCryptoStore(async ({ client, store, databasesSpy }) => {
      const cause = new Error("indexeddb unavailable");
      const flushSpy = vi.spyOn(store, "flush");
      const markCleanSpy = vi.spyOn(store, "markCleanShutdown");

      databasesSpy.mockRejectedValue(cause);
      await expect(client.stopAndPersist()).rejects.toBe(cause);
      expect(markCleanSpy).not.toHaveBeenCalled();
      expect(flushSpy).not.toHaveBeenCalled();
      expect(vi.mocked(context.getMatrixJsClient()).stopClient).toHaveBeenCalledTimes(1);
    });
  });

  it("falls back to one non-persisting SDK stop when public stop persistence fails", async () => {
    await withCryptoStore(async ({ client, store, databasesSpy }) => {
      const cause = new Error("indexeddb unavailable");
      const discardSpy = vi.spyOn(store, "discardPendingSyncCursorPersistence");

      databasesSpy.mockRejectedValue(cause);
      client.stop();

      await vi.waitFor(() => {
        expect(discardSpy).toHaveBeenCalledTimes(1);
      });
      expect(vi.mocked(context.getMatrixJsClient()).stopClient).toHaveBeenCalledTimes(1);
    });
  });
}

export function registerCryptoStartupAbortTest(context: CryptoPersistenceContext): void {
  it("does not persist or start sync when startup aborts during crypto initialization", async () => {
    const fixture = createCryptoFixture(context, "openclaw-matrix-startup-abort");
    const initCrypto = createDeferred<void>();
    const initStarted = createDeferred<void>();
    vi.mocked(context.getMatrixJsClient()).initRustCrypto.mockImplementation(async () => {
      initStarted.resolve();
      await initCrypto.promise;
      await fixture.seed("unpublished-key");
    });
    const abortController = new AbortController();

    let client: MatrixClient | undefined;
    let startupResult: Promise<void> | undefined;
    try {
      client = fixture.create();
      const startup = client.start({ abortSignal: abortController.signal });
      startupResult = context.expectAbortError(startup);

      await initStarted.promise;
      abortController.abort();
      expect(vi.mocked(context.getMatrixJsClient()).startClient).not.toHaveBeenCalled();

      initCrypto.resolve();
      await startupResult;
      expect(await readMatrixIdbSnapshotJson(fixture.tempDir)).toBeNull();
      expect(vi.mocked(context.getMatrixJsClient()).startClient).not.toHaveBeenCalled();
    } finally {
      initCrypto.resolve();
      await startupResult;
      await client?.stopWithoutPersist();
      await fixture.cleanup();
    }
  });
}

export function registerCryptoOneOffInitializationTests(
  context: CryptoPersistenceContext,
  prepareReadAuthority: () => void,
): void {
  it("single-flights host-authorized one-off crypto initialization", async () => {
    prepareReadAuthority();
    const fixture = createCryptoFixture(context);
    context.clearMatrixSyncApiForNeverStartedClient();
    const matrixJsClient = vi.mocked(context.getMatrixJsClient());
    const initStarted = createDeferred<void>();
    const finishInit = createDeferred<void>();
    matrixJsClient.initRustCrypto.mockImplementation(async () => {
      initStarted.resolve();
      await finishInit.promise;
    });
    const client = fixture.create();
    const preparations = Promise.allSettled([client.prepareForOneOff(), client.prepareForOneOff()]);
    try {
      await initStarted.promise;
      await setImmediate();
      expect(matrixJsClient.initRustCrypto).toHaveBeenCalledTimes(1);
      finishInit.resolve();
      await expect(preparations).resolves.toEqual([
        { status: "fulfilled", value: undefined },
        { status: "fulfilled", value: undefined },
      ]);
      expect(matrixJsClient.initRustCrypto).toHaveBeenCalledTimes(1);
    } finally {
      finishInit.reject(new Error("crypto initialization fixture cleanup"));
      await preparations;
      await client.stopWithoutPersist();
      await fixture.cleanup();
    }
  });

  it("joins pending one-off crypto initialization before completing discard shutdown", async () => {
    prepareReadAuthority();
    const fixture = createCryptoFixture(context);
    context.clearMatrixSyncApiForNeverStartedClient();
    const matrixJsClient = vi.mocked(context.getMatrixJsClient());
    const initStarted = createDeferred<void>();
    const finishInit = createDeferred<void>();
    let backendLive = false;
    matrixJsClient.initRustCrypto.mockImplementation(async () => {
      initStarted.resolve();
      await finishInit.promise;
      backendLive = true;
    });
    matrixJsClient.stopClient.mockImplementation(() => {
      backendLive = false;
    });
    const client = fixture.create();
    const preparation = client.prepareForOneOff();
    const preparationSettled = Promise.allSettled([preparation]);
    let shutdown: Promise<void> | undefined;
    try {
      await initStarted.promise;
      let shutdownFinished = false;
      shutdown = client.stopWithoutPersist().then(() => {
        shutdownFinished = true;
      });
      const shutdownSettled = Promise.allSettled([shutdown]);
      await setImmediate();
      const finishedBeforeInit = shutdownFinished;
      finishInit.resolve();
      await Promise.all([preparationSettled, shutdownSettled]);
      expect(backendLive).toBe(false);
      expect(finishedBeforeInit).toBe(false);
      await expect(shutdown).resolves.toBeUndefined();
      await context.expectAbortError(preparation);
    } finally {
      finishInit.reject(new Error("crypto initialization fixture cleanup"));
      await preparationSettled;
      await shutdown?.catch(() => undefined);
      await client.stopWithoutPersist();
      await fixture.cleanup();
    }
  });
}

export function registerCryptoPeriodicShutdownTest(context: CryptoPersistenceContext): void {
  it("awaits and cancels active periodic crypto persistence during discard shutdown", async () => {
    const fixture = createCryptoFixture(context, "openclaw-matrix-interval");
    const pendingDatabases = createDeferred<IDBDatabaseInfo[]>();
    const dumping = createDeferred<void>();
    const stopped = createDeferred<void>();
    vi.mocked(context.getMatrixJsClient()).stopClient.mockImplementation(() => stopped.resolve());
    const databasesSpy = vi.spyOn(indexedDB, "databases");
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    const warnSpy = vi.spyOn(LogService, "warn").mockImplementation(() => {});
    let shutdown: Promise<void> | undefined;

    try {
      const client = fixture.create();

      await client.start();
      await fixture.seed("unpublished-key");
      const databases = await indexedDB.databases();
      databasesSpy.mockClear().mockImplementation(() => {
        dumping.resolve();
        return pendingDatabases.promise;
      });

      const intervalCall = setIntervalSpy.mock.calls.find((call) => call[1] === 60_000);
      if (!intervalCall || typeof intervalCall[0] !== "function") {
        throw new Error("expected Matrix IDB snapshot interval");
      }
      intervalCall[0]();
      intervalCall[0]();
      await dumping.promise;
      expect(databasesSpy).toHaveBeenCalledTimes(1);

      shutdown = Promise.resolve(client.stopWithoutPersist());
      let shutdownSettled = false;
      void shutdown.then(() => {
        shutdownSettled = true;
      });
      await stopped.promise;
      // Let shutdown continuations settle while the snapshot writer remains blocked.
      await setImmediate();
      expect(vi.mocked(context.getMatrixJsClient()).stopClient).toHaveBeenCalledTimes(1);
      expect(shutdownSettled).toBe(false);

      pendingDatabases.resolve(databases);
      await shutdown;
      expect(await readMatrixIdbSnapshotJson(fixture.tempDir)).toBeNull();
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      pendingDatabases.resolve([]);
      await shutdown?.catch(() => undefined);
      warnSpy.mockRestore();
      databasesSpy.mockRestore();
      setIntervalSpy.mockRestore();
      await fixture.cleanup();
    }
  });
}
