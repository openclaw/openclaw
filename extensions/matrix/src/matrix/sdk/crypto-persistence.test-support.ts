import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import type { MatrixClient as MatrixJsSdkClient } from "matrix-js-sdk/lib/matrix.js";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { expect, it, vi } from "vitest";
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

export function registerCryptoShutdownTests(context: CryptoPersistenceContext): void {
  const { createSdkClient, clearMatrixSyncApiForNeverStartedClient } = context;
  it("persists crypto before marking and flushing the clean sync cursor", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-matrix-sdk-store-"));
    resetPluginStateStoreForTests();
    installMatrixTestRuntime();
    clearMatrixSyncApiForNeverStartedClient();
    const cause = new Error("sync store flush failed");
    const pendingDatabases = createDeferred<IDBDatabaseInfo[]>();
    const dumping = createDeferred<void>();
    const databasesSpy = vi.spyOn(indexedDB, "databases");
    let shutdown: Promise<void> | undefined;

    let client: MatrixClient | undefined;
    try {
      client = createSdkClient({
        encryption: true,
        cryptoDatabasePrefix: path.basename(tempDir),
        syncStore: await SqliteBackedMatrixSyncStore.create(tempDir),
        idbSnapshotPath: path.join(tempDir, "crypto-idb-snapshot.json"),
      });

      await client.prepareForOneOff();

      await seedDatabase({
        name: path.basename(tempDir) + "::crypto",
        storeName: "keys",
        records: [{ key: "session", value: "fresh-key" }],
      });

      // SAFETY: createSdkClient forwards the SQLite syncStore supplied above to the SDK.
      const store = context.getSyncStore() as
        | { flush: () => Promise<void>; markCleanShutdown: () => void }
        | undefined;
      if (!store) {
        throw new Error("expected Matrix sync store");
      }
      const flushSpy = vi.spyOn(store, "flush").mockRejectedValue(cause);
      const markCleanSpy = vi.spyOn(store, "markCleanShutdown");

      const databases = await indexedDB.databases();
      databasesSpy.mockImplementation(() => {
        dumping.resolve();
        return pendingDatabases.promise;
      });
      shutdown = client.stopAndPersist();
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
      await shutdown?.catch(() => undefined);
      databasesSpy.mockRestore();
      await client?.stopWithoutPersist();
      await clearAllIndexedDbState({ databasePrefix: path.basename(tempDir) });
      resetPluginStateStoreForTests();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("does not mark or flush the sync cursor when strict crypto persistence fails", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-matrix-sdk-store-"));
    resetPluginStateStoreForTests();
    installMatrixTestRuntime();
    clearMatrixSyncApiForNeverStartedClient();
    const cause = new Error("indexeddb unavailable");
    const databasesSpy = vi.spyOn(indexedDB, "databases");

    let client: MatrixClient | undefined;
    try {
      client = createSdkClient({
        encryption: true,
        cryptoDatabasePrefix: path.basename(tempDir),
        syncStore: await SqliteBackedMatrixSyncStore.create(tempDir),
        idbSnapshotPath: path.join(tempDir, "crypto-idb-snapshot.json"),
      });

      await client.prepareForOneOff();

      await seedDatabase({
        name: path.basename(tempDir) + "::crypto",
        storeName: "keys",
        records: [{ key: "session", value: "fresh-key" }],
      });

      // SAFETY: createSdkClient forwards the SQLite syncStore supplied above to the SDK.
      const store = context.getSyncStore() as
        | { flush: () => Promise<void>; markCleanShutdown: () => void }
        | undefined;
      if (!store) {
        throw new Error("expected Matrix sync store");
      }
      const flushSpy = vi.spyOn(store, "flush");
      const markCleanSpy = vi.spyOn(store, "markCleanShutdown");

      databasesSpy.mockRejectedValue(cause);
      await expect(client.stopAndPersist()).rejects.toBe(cause);
      expect(markCleanSpy).not.toHaveBeenCalled();
      expect(flushSpy).not.toHaveBeenCalled();
      expect(vi.mocked(context.getMatrixJsClient()).stopClient).toHaveBeenCalledTimes(1);
    } finally {
      databasesSpy.mockRestore();
      await client?.stopWithoutPersist();
      await clearAllIndexedDbState({ databasePrefix: path.basename(tempDir) });
      resetPluginStateStoreForTests();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("falls back to one non-persisting SDK stop when public stop persistence fails", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-matrix-sdk-stop-"));
    resetPluginStateStoreForTests();
    installMatrixTestRuntime();
    clearMatrixSyncApiForNeverStartedClient();
    const cause = new Error("indexeddb unavailable");
    const databasesSpy = vi.spyOn(indexedDB, "databases");

    let client: MatrixClient | undefined;
    try {
      client = createSdkClient({
        encryption: true,
        cryptoDatabasePrefix: path.basename(tempDir),
        syncStore: await SqliteBackedMatrixSyncStore.create(tempDir),
        idbSnapshotPath: path.join(tempDir, "crypto-idb-snapshot.json"),
      });
      await client.prepareForOneOff();

      await seedDatabase({
        name: path.basename(tempDir) + "::crypto",
        storeName: "keys",
        records: [{ key: "session", value: "fresh-key" }],
      });

      // SAFETY: createSdkClient forwards the SQLite syncStore supplied above to the SDK.
      const store = context.getSyncStore() as
        | { discardPendingSyncCursorPersistence: () => void }
        | undefined;
      if (!store) {
        throw new Error("expected Matrix sync store");
      }
      const discardSpy = vi.spyOn(store, "discardPendingSyncCursorPersistence");

      databasesSpy.mockRejectedValue(cause);
      client.stop();

      await vi.waitFor(() => {
        expect(discardSpy).toHaveBeenCalledTimes(1);
      });
      expect(vi.mocked(context.getMatrixJsClient()).stopClient).toHaveBeenCalledTimes(1);
    } finally {
      databasesSpy.mockRestore();
      await client?.stopWithoutPersist();
      await clearAllIndexedDbState({ databasePrefix: path.basename(tempDir) });
      resetPluginStateStoreForTests();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
}

export function registerCryptoStartupAbortTest(context: CryptoPersistenceContext): void {
  const { createSdkClient, tempDirs, expectAbortError } = context;
  it("does not persist or start sync when startup aborts during crypto initialization", async () => {
    resetPluginStateStoreForTests();
    installMatrixTestRuntime();
    const tempDir = tempDirs.make("matrix-idb-startup-abort-");
    const databasePrefix = "openclaw-matrix-startup-abort";
    const initCrypto = createDeferred<void>();
    const initStarted = createDeferred<void>();
    vi.mocked(context.getMatrixJsClient()).initRustCrypto.mockImplementation(async () => {
      initStarted.resolve();
      await initCrypto.promise;
      await seedDatabase({
        name: databasePrefix + "::crypto",
        storeName: "keys",
        records: [{ key: "session", value: "unpublished-key" }],
      });
    });
    const abortController = new AbortController();

    let client: MatrixClient | undefined;
    let startupResult: Promise<void> | undefined;
    try {
      client = createSdkClient({
        encryption: true,
        idbSnapshotPath: path.join(tempDir, "crypto-idb-snapshot.json"),
        cryptoDatabasePrefix: databasePrefix,
      });
      const startup = client.start({ abortSignal: abortController.signal });
      startupResult = expectAbortError(startup);

      await initStarted.promise;
      abortController.abort();
      expect(vi.mocked(context.getMatrixJsClient()).startClient).not.toHaveBeenCalled();

      initCrypto.resolve();
      await startupResult;
      expect(await readMatrixIdbSnapshotJson(tempDir)).toBeNull();
      expect(vi.mocked(context.getMatrixJsClient()).startClient).not.toHaveBeenCalled();
    } finally {
      initCrypto.resolve();
      await startupResult;
      await client?.stopWithoutPersist();
      await clearAllIndexedDbState({ databasePrefix });
      resetPluginStateStoreForTests();
    }
  });
}

export function registerCryptoPeriodicShutdownTest(context: CryptoPersistenceContext): void {
  const { createSdkClient, tempDirs } = context;
  it("awaits and cancels active periodic crypto persistence during discard shutdown", async () => {
    resetPluginStateStoreForTests();
    installMatrixTestRuntime();
    const tempDir = tempDirs.make("matrix-idb-interval-");
    const pendingDatabases = createDeferred<IDBDatabaseInfo[]>();
    const dumping = createDeferred<void>();
    const stopped = createDeferred<void>();
    vi.mocked(context.getMatrixJsClient()).stopClient.mockImplementation(() => stopped.resolve());
    const databasesSpy = vi.spyOn(indexedDB, "databases");
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    const warnSpy = vi.spyOn(LogService, "warn").mockImplementation(() => {});
    let shutdown: Promise<void> | undefined;

    try {
      const client = createSdkClient({
        encryption: true,
        idbSnapshotPath: path.join(tempDir, "crypto-idb-snapshot.json"),
        cryptoDatabasePrefix: "openclaw-matrix-interval",
      });

      await client.start();
      await seedDatabase({
        name: "openclaw-matrix-interval::crypto",
        storeName: "keys",
        records: [{ key: "session", value: "unpublished-key" }],
      });
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
      expect(await readMatrixIdbSnapshotJson(tempDir)).toBeNull();
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      pendingDatabases.resolve([]);
      await shutdown?.catch(() => undefined);
      warnSpy.mockRestore();
      databasesSpy.mockRestore();
      setIntervalSpy.mockRestore();
      await clearAllIndexedDbState({ databasePrefix: "openclaw-matrix-interval" });
      resetPluginStateStoreForTests();
    }
  });
}
