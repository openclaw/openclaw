// Matrix tests cover idb persistence plugin behavior.
import "fake-indexeddb/auto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { backup } from "node:sqlite";
import { toErrorObject } from "openclaw/plugin-sdk/error-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { resetFileLockStateForTest } from "openclaw/plugin-sdk/file-lock";
import type { OpenAsyncKeyedStoreOptions } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateKeyedStoreForTests,
  openOpenClawStateDatabase,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getMatrixRuntime, setMatrixRuntime } from "../../runtime.js";
import { installMatrixTestRuntime } from "../../test-runtime.js";
import {
  openMatrixIdbSnapshotStoreOptions,
  readMatrixIdbSnapshotJson,
  writeMatrixIdbSnapshotJson,
  type MatrixSnapshotStateRuntime,
} from "../crypto-state-store.js";
import { acquireMatrixCryptoStoreOwnership } from "./crypto-store-ownership.js";
import { observeCryptoStoreWaiter } from "./crypto-store-ownership.test-helpers.js";
import { persistIdbToDisk, restoreIdbFromDisk } from "./idb-persistence.js";
import {
  clearAllIndexedDbState,
  readDatabaseRecords,
  seedDatabase,
} from "./idb-persistence.test-helpers.js";
import { LogService } from "./logger.js";

const DATABASE_PREFIX = "openclaw-matrix-persistence-test";
const OTHER_DATABASE_PREFIX = "openclaw-matrix-persistence-other-test";
const cryptoDatabaseName = `${DATABASE_PREFIX}::matrix-sdk-crypto`;
const otherCryptoDatabaseName = `${OTHER_DATABASE_PREFIX}::matrix-sdk-crypto`;

async function clearTestIndexedDbState(): Promise<void> {
  await clearAllIndexedDbState({ databasePrefix: DATABASE_PREFIX });
  await clearAllIndexedDbState({ databasePrefix: OTHER_DATABASE_PREFIX });
}

describe("Matrix IndexedDB persistence", () => {
  let tmpDir: string;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    resetPluginStateStoreForTests();
    installMatrixTestRuntime();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "matrix-idb-persist-"));
    warnSpy = vi.spyOn(LogService, "warn").mockImplementation(() => {});
    await clearTestIndexedDbState();
  });

  afterEach(async () => {
    warnSpy.mockRestore();
    await clearTestIndexedDbState();
    await closeOpenClawStateDatabaseAsync();
    resetFileLockStateForTest();
    resetPluginStateStoreForTests();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("holds exclusive crypto-store ownership until release", async () => {
    const snapshotPath = path.join(tmpDir, "crypto-idb-snapshot.json");
    const first = await acquireMatrixCryptoStoreOwnership(snapshotPath);
    const waiter = await observeCryptoStoreWaiter(snapshotPath);
    const waiting = acquireMatrixCryptoStoreOwnership(snapshotPath);
    try {
      await waiter.waitFor(waiting);
      await first.release();
      const replacement = await waiting;
      await replacement.release();
    } finally {
      waiter.close();
    }
  });

  it("refuses a successor after a failed final state publication", async () => {
    const snapshotPath = path.join(tmpDir, "crypto-idb-snapshot.json");
    const owner = await acquireMatrixCryptoStoreOwnership(snapshotPath);
    await owner.armUnsafeState();
    await owner.release();
    await expect(acquireMatrixCryptoStoreOwnership(snapshotPath)).rejects.toThrow(
      "unresolved unsafe final state",
    );
  });

  it("refuses a waiting successor when the departing owner poisons before unlock", async () => {
    const snapshotPath = path.join(tmpDir, "crypto-idb-snapshot.json");
    const owner = await acquireMatrixCryptoStoreOwnership(snapshotPath);
    const waiter = await observeCryptoStoreWaiter(snapshotPath);
    const successor = acquireMatrixCryptoStoreOwnership(snapshotPath);
    try {
      await waiter.waitFor(successor);
      await owner.armUnsafeState();
      await owner.release();
      await expect(successor).rejects.toThrow("unresolved unsafe final state");
    } finally {
      waiter.close();
    }
  });

  it("persists and restores database contents for the selected prefix", async () => {
    const snapshotPath = path.join(tmpDir, "crypto-idb-snapshot.json");
    await seedDatabase({
      name: cryptoDatabaseName,
      storeName: "sessions",
      records: [{ key: "room-1", value: { session: "abc123" } }],
    });
    await seedDatabase({
      name: otherCryptoDatabaseName,
      storeName: "sessions",
      records: [{ key: "room-2", value: { session: "should-not-restore" } }],
    });

    await persistIdbToDisk({
      snapshotPath,
      databasePrefix: DATABASE_PREFIX,
    });
    expect(fs.existsSync(snapshotPath)).toBe(false);

    await clearAllIndexedDbState({ databasePrefix: DATABASE_PREFIX });

    const restored = await restoreIdbFromDisk(
      snapshotPath,
      getMatrixRuntime().state,
      DATABASE_PREFIX,
    );
    expect(restored).toBe(true);

    const restoredRecords = await readDatabaseRecords({
      name: cryptoDatabaseName,
      storeName: "sessions",
    });
    expect(restoredRecords).toEqual([{ key: "room-1", value: { session: "abc123" } }]);

    const dbs = await indexedDB.databases();
    expect(dbs.map((entry) => entry.name)).toContain(otherCryptoDatabaseName);
    expect(
      await readDatabaseRecords({ name: otherCryptoDatabaseName, storeName: "sessions" }),
    ).toEqual([{ key: "room-2", value: { session: "should-not-restore" } }]);
  });

  it.each(["[]", "{}", "null", "", "{"])(
    "refuses invalid canonical snapshot %j without deleting retained crypto keys",
    async (snapshotJson) => {
      const snapshotPath = path.join(tmpDir, "crypto-idb-snapshot.json");
      const records = [{ key: "room-1", value: { session: "retained-key" } }];
      await seedDatabase({ name: cryptoDatabaseName, storeName: "sessions", records });
      await writeMatrixIdbSnapshotJson({
        storageRootDir: tmpDir,
        snapshotJson,
        databaseCount: 1,
      });

      await expect(
        restoreIdbFromDisk(snapshotPath, getMatrixRuntime().state, DATABASE_PREFIX),
      ).rejects.toThrow();
      expect(
        await readDatabaseRecords({ name: cryptoDatabaseName, storeName: "sessions" }),
      ).toEqual(records);
      await expect(
        persistIdbToDisk({ snapshotPath, databasePrefix: DATABASE_PREFIX, strict: true }),
      ).rejects.toThrow();
      expect(await readMatrixIdbSnapshotJson(tmpDir)).toBe(snapshotJson);
    },
  );

  it.each([
    "metadata",
    "null metadata",
    "missing metadata",
    "missing chunk",
    "malformed chunk",
    "digest",
  ] as const)(
    "refuses corrupt snapshot %s without deleting keys or replacing stored state",
    async (corruption) => {
      const snapshotPath = path.join(tmpDir, "crypto-idb-snapshot.json");
      const records = [{ key: "room-1", value: { session: "retained-key" } }];
      await seedDatabase({ name: cryptoDatabaseName, storeName: "sessions", records });
      await persistIdbToDisk({ snapshotPath, databasePrefix: DATABASE_PREFIX, strict: true });
      const store = createPluginStateKeyedStoreForTests<Record<string, unknown> | null>(
        "matrix",
        openMatrixIdbSnapshotStoreOptions(tmpDir),
      );
      const meta = await store.lookup("current:meta");
      if (!meta || typeof meta.generation !== "string") {
        throw new Error("expected published snapshot metadata");
      }
      const chunkKey = `current:snapshot:${meta.generation}:0`;
      if (corruption === "missing metadata") {
        await store.delete("current:meta");
      } else if (corruption === "null metadata") {
        await store.register("current:meta", null);
      } else if (corruption === "missing chunk") {
        await store.delete(chunkKey);
      } else if (corruption === "malformed chunk") {
        const chunk = await store.lookup(chunkKey);
        await store.register(chunkKey, { ...chunk, index: -1 });
      } else {
        await store.register(
          "current:meta",
          corruption === "metadata" ? { ...meta, version: 0 } : { ...meta, digest: "incorrect" },
        );
      }
      const storedRows = await store.entries();

      await expect(
        restoreIdbFromDisk(snapshotPath, getMatrixRuntime().state, DATABASE_PREFIX),
      ).rejects.toThrow();
      expect(
        await readDatabaseRecords({ name: cryptoDatabaseName, storeName: "sessions" }),
      ).toEqual(records);
      await expect(
        persistIdbToDisk({ snapshotPath, databasePrefix: DATABASE_PREFIX, strict: true }),
      ).rejects.toThrow();
      expect(await store.entries()).toEqual(storedRows);
    },
  );

  it("replaces stale in-memory crypto records when ownership returns", async () => {
    const snapshotPath = path.join(tmpDir, "crypto-idb-snapshot.json");
    await seedDatabase({
      name: cryptoDatabaseName,
      storeName: "sessions",
      records: [{ key: "durable", value: { session: "saved" } }],
    });
    await persistIdbToDisk({ snapshotPath, databasePrefix: DATABASE_PREFIX });
    await seedDatabase({
      name: cryptoDatabaseName,
      storeName: "sessions",
      records: [{ key: "stale", value: { session: "old-owner" } }],
    });
    await restoreIdbFromDisk(snapshotPath, undefined, DATABASE_PREFIX);
    expect(await readDatabaseRecords({ name: cryptoDatabaseName, storeName: "sessions" })).toEqual([
      { key: "durable", value: { session: "saved" } },
    ]);
  });

  it("refuses a new account engine when its durable snapshot cannot be replayed", async () => {
    const snapshotPath = path.join(tmpDir, "crypto-idb-snapshot.json");
    await writeMatrixIdbSnapshotJson({
      storageRootDir: tmpDir,
      snapshotJson: "not valid JSON",
      databaseCount: 1,
    });
    await expect(restoreIdbFromDisk(snapshotPath, undefined, DATABASE_PREFIX)).rejects.toThrow();
  });

  it("uses the client-owned state runtime after the ambient plugin scope changes", async () => {
    const snapshotPath = path.join(tmpDir, "crypto-idb-snapshot.json");
    const originalRuntime = getMatrixRuntime();
    const stateRuntime = { openKeyedStoreV2: originalRuntime.state.openKeyedStoreV2 };
    await seedDatabase({
      name: cryptoDatabaseName,
      storeName: "sessions",
      records: [{ key: "room-owned", value: { session: "retained-runtime" } }],
    });
    setMatrixRuntime({
      ...originalRuntime,
      state: {
        ...originalRuntime.state,
        openKeyedStoreV2: () => {
          throw new Error("ambient Matrix runtime is unavailable");
        },
      },
    });

    await persistIdbToDisk({
      snapshotPath,
      databasePrefix: DATABASE_PREFIX,
      stateRuntime,
    });
    await clearTestIndexedDbState();
    await expect(restoreIdbFromDisk(snapshotPath, stateRuntime)).resolves.toBe(true);
    await expect(
      readDatabaseRecords({ name: cryptoDatabaseName, storeName: "sessions" }),
    ).resolves.toEqual([{ key: "room-owned", value: { session: "retained-runtime" } }]);
  });

  it.each([
    { failure: "invalid record key", errorName: "DataError", invalidKey: true, later: false },
    {
      failure: "unique index conflict",
      errorName: "ConstraintError",
      invalidKey: false,
      later: false,
    },
    { failure: "invalid later database", errorName: "DataError", invalidKey: true, later: true },
  ])(
    "preserves retained account keys after $failure during replay",
    async ({ errorName, invalidKey, later }) => {
      const snapshotPath = path.join(tmpDir, "crypto-idb-snapshot.json");
      const retained = [{ key: "retained", value: { session: "retained-key" } }];
      const unrelated = [{ key: "other-room", value: { session: "other-account-key" } }];
      await seedDatabase({
        name: cryptoDatabaseName,
        version: 3,
        storeName: "sessions",
        records: retained,
      });
      await seedDatabase({
        name: otherCryptoDatabaseName,
        storeName: "sessions",
        records: unrelated,
      });
      const databasesBefore = await indexedDB.databases();
      const invalidStore = {
        name: "sessions",
        keyPath: null,
        autoIncrement: false,
        indexes: [{ name: "session", keyPath: "session", multiEntry: false, unique: true }],
        records: [
          { key: "room-1", value: { session: "duplicate" } },
          { key: invalidKey ? null : "room-2", value: { session: "duplicate" } },
        ],
      };
      const snapshot = [{ name: cryptoDatabaseName, version: 1, stores: [invalidStore] }];
      if (later) {
        snapshot[0]!.stores = [{ ...invalidStore, records: [invalidStore.records[0]!] }];
        snapshot.push({ name: `${DATABASE_PREFIX}::later`, version: 1, stores: [invalidStore] });
      }
      const snapshotJson = JSON.stringify(snapshot);
      await writeMatrixIdbSnapshotJson({
        storageRootDir: tmpDir,
        databaseCount: snapshot.length,
        snapshotJson,
      });
      await expect(
        restoreIdbFromDisk(snapshotPath, getMatrixRuntime().state, DATABASE_PREFIX),
      ).rejects.toMatchObject({
        name: errorName,
      });
      expect(await indexedDB.databases()).toEqual(databasesBefore);
      expect(
        await readDatabaseRecords({ name: cryptoDatabaseName, version: 3, storeName: "sessions" }),
      ).toEqual(retained);
      expect(
        await readDatabaseRecords({ name: otherCryptoDatabaseName, storeName: "sessions" }),
      ).toEqual(unrelated);
      expect(await readMatrixIdbSnapshotJson(tmpDir)).toBe(snapshotJson);
      expect(warnSpy).toHaveBeenCalledWith(
        "IdbPersistence",
        "Failed to restore IndexedDB snapshot from SQLite:",
        expect.objectContaining({ name: errorName }),
      );
      await new Promise<void>((resolve, reject) => {
        const request = indexedDB.deleteDatabase(cryptoDatabaseName);
        request.addEventListener("success", () => resolve(), { once: true });
        request.addEventListener(
          "error",
          () => reject(toErrorObject(request.error, "IndexedDB deletion failed")),
          { once: true },
        );
        request.addEventListener(
          "blocked",
          () => reject(new Error("Failed restore left its IndexedDB connection open")),
          { once: true },
        );
      });
    },
  );

  it.each(["duplicate", "foreign account"])(
    "refuses %s snapshot database names without changing retained keys",
    async (invalidName) => {
      const snapshotPath = path.join(tmpDir, "crypto-idb-snapshot.json");
      const retained = [{ key: "retained", value: { session: "retained-key" } }];
      for (const name of [cryptoDatabaseName, otherCryptoDatabaseName]) {
        await seedDatabase({ name, storeName: "sessions", records: retained });
      }
      const snapshotJson = JSON.stringify([
        { name: cryptoDatabaseName, version: 1, stores: [] },
        {
          name: invalidName === "duplicate" ? cryptoDatabaseName : otherCryptoDatabaseName,
          version: 1,
          stores: [],
        },
      ]);
      await writeMatrixIdbSnapshotJson({
        storageRootDir: tmpDir,
        databaseCount: 2,
        snapshotJson,
      });
      await expect(
        restoreIdbFromDisk(snapshotPath, getMatrixRuntime().state, DATABASE_PREFIX),
      ).rejects.toThrow("Malformed IndexedDB snapshot database names");
      for (const name of [cryptoDatabaseName, otherCryptoDatabaseName]) {
        expect(await readDatabaseRecords({ name, storeName: "sessions" })).toEqual(retained);
      }
      expect(await readMatrixIdbSnapshotJson(tmpDir)).toBe(snapshotJson);
    },
  );

  it("reassembles exact snapshot bytes beyond chunk 9", async () => {
    const snapshotJson = JSON.stringify({
      records: Array.from({ length: 24 }, (_, index) => `${index}:🦞${"x".repeat(15_000)}`),
    });
    await writeMatrixIdbSnapshotJson({ storageRootDir: tmpDir, snapshotJson, databaseCount: 1 });
    const store = createPluginStateKeyedStoreForTests<Record<string, unknown>>(
      "matrix",
      openMatrixIdbSnapshotStoreOptions(tmpDir),
    );
    const stateRuntime: MatrixSnapshotStateRuntime = {
      openKeyedStoreV2<T>(options: OpenAsyncKeyedStoreOptions) {
        return createPluginStateKeyedStoreForTests<T>("matrix", options);
      },
    };
    expect(await readMatrixIdbSnapshotJson(tmpDir)).toBe(snapshotJson);
    await expect(readMatrixIdbSnapshotJson(tmpDir, stateRuntime)).resolves.toBe(snapshotJson);
    const chunk = (await store.entries()).find(
      (row) => row.value.kind === "snapshot-chunk" && row.value.index === 10,
    );
    expect(chunk).toBeDefined();
    if (!chunk || chunk.value.kind !== "snapshot-chunk") {
      throw new Error("expected snapshot chunk 10");
    }
    await store.register(chunk.key, { ...chunk.value, data: "modified" });
    await expect(readMatrixIdbSnapshotJson(tmpDir, stateRuntime)).rejects.toMatchObject({
      code: "matrix-idb-snapshot-invalid",
    });
    const laterChunk = (await store.entries()).find(
      (row) => row.value.kind === "snapshot-chunk" && row.value.index === 11,
    );
    if (!laterChunk) {
      throw new Error("expected snapshot chunk 11");
    }
    await store.register(chunk.key, { ...chunk.value, index: -1 });
    await expect(readMatrixIdbSnapshotJson(tmpDir)).rejects.toMatchObject({
      code: "matrix-idb-snapshot-invalid",
    });
    await expect(readMatrixIdbSnapshotJson(tmpDir, stateRuntime)).rejects.toMatchObject({
      code: "matrix-idb-snapshot-invalid",
    });
    await store.delete(chunk.key);
    await expect(readMatrixIdbSnapshotJson(tmpDir)).rejects.toMatchObject({
      code: "matrix-idb-snapshot-invalid",
    });
    await expect(readMatrixIdbSnapshotJson(tmpDir, stateRuntime)).rejects.toMatchObject({
      code: "matrix-idb-snapshot-invalid",
    });
    await store.register(chunk.key, chunk.value);
    await closeOpenClawStateDatabaseAsync();
    const source = openOpenClawStateDatabase({
      env: openMatrixIdbSnapshotStoreOptions(tmpDir).env,
    });
    const corruptRoot = path.join(tmpDir, "corrupt-startup");
    fs.mkdirSync(path.join(corruptRoot, "state"), { recursive: true });
    await backup(source.db, path.join(corruptRoot, "state", "openclaw.sqlite"));
    await closeOpenClawStateDatabaseAsync();
    // Seed corruption before the new database has any cached keyed-store receipts.
    const corrupt = openOpenClawStateDatabase({
      env: openMatrixIdbSnapshotStoreOptions(corruptRoot).env,
    });
    expect(
      corrupt.db
        .prepare("UPDATE plugin_state_entries SET value_json = ? WHERE entry_key = ?")
        .run("invalid JSON", laterChunk.key).changes,
    ).toBe(1);
    await closeOpenClawStateDatabaseAsync();
    await expect(readMatrixIdbSnapshotJson(corruptRoot)).rejects.toMatchObject({
      code: "PLUGIN_STATE_CORRUPT",
    });
    await expect(readMatrixIdbSnapshotJson(corruptRoot, stateRuntime)).rejects.toMatchObject({
      code: "PLUGIN_STATE_CORRUPT",
    });
  });

  it.each(["absent", "valid", "malformed"] as const)(
    "refuses retired snapshot JSON when canonical SQLite state is %s",
    async (canonicalState) => {
      const snapshotPath = path.join(tmpDir, "crypto-idb-snapshot.json");
      const snapshot = JSON.stringify([{ name: cryptoDatabaseName, version: 1, stores: [] }]);
      const canonicalSnapshot =
        canonicalState === "absent"
          ? null
          : canonicalState === "valid"
            ? JSON.stringify([{ name: otherCryptoDatabaseName, version: 1, stores: [] }])
            : JSON.stringify({ malformed: true });
      if (canonicalSnapshot !== null) {
        await writeMatrixIdbSnapshotJson({
          storageRootDir: tmpDir,
          snapshotJson: canonicalSnapshot,
          databaseCount: 1,
        });
      }
      fs.writeFileSync(snapshotPath, snapshot);
      const remediation =
        'Install OpenClaw 2026.9.5, run "openclaw doctor --fix", and start the Matrix channel once to migrate it, then upgrade to latest.';

      await expect(restoreIdbFromDisk(snapshotPath)).rejects.toMatchObject({
        name: "MatrixIdbSnapshotMigrationRequiredError",
        code: "matrix-idb-snapshot-requires-doctor",
        remediation,
      });
      expect(warnSpy).toHaveBeenCalledWith(
        "IdbPersistence",
        expect.objectContaining({
          code: "matrix-idb-snapshot-requires-doctor",
          remediation,
        }),
      );
      expect(JSON.stringify(warnSpy.mock.calls)).not.toContain(snapshotPath);
      const databaseNames = (await indexedDB.databases()).map((database) => database.name);
      expect(databaseNames).not.toContain(cryptoDatabaseName);
      expect(databaseNames).not.toContain(otherCryptoDatabaseName);

      await seedDatabase({
        name: cryptoDatabaseName,
        storeName: "sessions",
        records: [{ key: "new-room", value: { session: "new" } }],
      });
      await expect(
        persistIdbToDisk({ snapshotPath, databasePrefix: DATABASE_PREFIX }),
      ).rejects.toMatchObject({
        code: "matrix-idb-snapshot-requires-doctor",
        remediation,
      });
      expect(await readMatrixIdbSnapshotJson(tmpDir)).toBe(canonicalSnapshot);
      expect(fs.readFileSync(snapshotPath, "utf8")).toBe(snapshot);

      const storeSpy = vi
        .spyOn(getMatrixRuntime().state, "openKeyedStoreV2")
        .mockImplementation(() => {
          throw new Error("sqlite unavailable");
        });
      try {
        await expect(restoreIdbFromDisk(snapshotPath)).rejects.toMatchObject({
          code: "matrix-idb-snapshot-requires-doctor",
          remediation,
        });
      } finally {
        storeSpy.mockRestore();
      }
    },
  );

  it("returns false without warning when the snapshot does not exist yet", async () => {
    const restored = await restoreIdbFromDisk(path.join(tmpDir, "crypto-idb-snapshot.json"));

    expect(restored).toBe(false);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("handles concurrent persist operations in SQLite state", async () => {
    const snapshotPath = path.join(tmpDir, "crypto-idb-snapshot.json");
    await seedDatabase({
      name: cryptoDatabaseName,
      storeName: "sessions",
      records: [{ key: "room-1", value: { session: "abc123" } }],
    });

    await Promise.all([
      persistIdbToDisk({ snapshotPath, databasePrefix: DATABASE_PREFIX }),
      persistIdbToDisk({ snapshotPath, databasePrefix: DATABASE_PREFIX }),
    ]);

    expect(fs.existsSync(snapshotPath)).toBe(false);
    await clearTestIndexedDbState();
    await expect(restoreIdbFromDisk(snapshotPath)).resolves.toBe(true);
    await expect(
      readDatabaseRecords({
        name: cryptoDatabaseName,
        storeName: "sessions",
      }),
    ).resolves.toEqual([{ key: "room-1", value: { session: "abc123" } }]);
  });

  it("strictly propagates final IndexedDB persistence failures", async () => {
    const cause = new Error("indexeddb unavailable");
    const databasesSpy = vi.spyOn(indexedDB, "databases").mockRejectedValue(cause);

    try {
      await expect(
        persistIdbToDisk({
          snapshotPath: path.join(tmpDir, "crypto-idb-snapshot.json"),
          databasePrefix: DATABASE_PREFIX,
          strict: true,
        }),
      ).rejects.toBe(cause);
    } finally {
      databasesSpy.mockRestore();
    }
  });

  it("cancels an active snapshot before writing without warning", async () => {
    const snapshotPath = path.join(tmpDir, "crypto-idb-snapshot.json");
    await seedDatabase({
      name: cryptoDatabaseName,
      storeName: "sessions",
      records: [{ key: "room-1", value: { session: "abc123" } }],
    });
    const databaseList = await indexedDB.databases();
    const pendingDatabases = createDeferred<IDBDatabaseInfo[]>();
    const databasesSpy = vi.spyOn(indexedDB, "databases").mockReturnValue(pendingDatabases.promise);
    const abortController = new AbortController();

    try {
      const persistence = persistIdbToDisk({
        snapshotPath,
        databasePrefix: DATABASE_PREFIX,
        abortSignal: abortController.signal,
      });
      await vi.waitFor(() => {
        expect(databasesSpy).toHaveBeenCalledTimes(1);
      });

      abortController.abort();
      pendingDatabases.resolve(databaseList);

      await expect(persistence).resolves.toBeUndefined();
      expect(await readMatrixIdbSnapshotJson(tmpDir)).toBeNull();
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      pendingDatabases.resolve(databaseList);
      databasesSpy.mockRestore();
    }
  });
});
