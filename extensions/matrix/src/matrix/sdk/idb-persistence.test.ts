import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { resetFileLockStateForTest } from "openclaw/plugin-sdk/file-lock";
import type { OpenAsyncKeyedStoreOptions } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateKeyedStoreForTests,
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
import { persistIdbToDisk, restoreIdbFromDisk } from "./idb-persistence.js";
import {
  clearAllIndexedDbState,
  readDatabaseRecords,
  requestResult,
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
  let snapshotPath: string;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  const records = (key: string, session: string) => [{ key, value: { session } }];
  const seed = (rows = records("room-1", "abc123"), name = cryptoDatabaseName, version?: number) =>
    seedDatabase({ name, version, storeName: "sessions", records: rows });
  const read = (name = cryptoDatabaseName, version?: number) =>
    readDatabaseRecords({ name, version, storeName: "sessions" });
  const persist = (strict?: boolean) =>
    persistIdbToDisk({ snapshotPath, databasePrefix: DATABASE_PREFIX, strict });
  const restore = () => restoreIdbFromDisk(snapshotPath, getMatrixRuntime().state, DATABASE_PREFIX);
  const write = (snapshotJson: string, databaseCount = 1) =>
    writeMatrixIdbSnapshotJson({ storageRootDir: tmpDir, snapshotJson, databaseCount });
  const snapshotStore = <T>() =>
    createPluginStateKeyedStoreForTests<T>("matrix", openMatrixIdbSnapshotStoreOptions(tmpDir));

  beforeEach(async () => {
    resetPluginStateStoreForTests();
    installMatrixTestRuntime();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "matrix-idb-persist-"));
    snapshotPath = path.join(tmpDir, "crypto-idb-snapshot.json");
    warnSpy = vi.spyOn(LogService, "warn").mockImplementation(() => {});
    await clearTestIndexedDbState();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await clearTestIndexedDbState();
    await closeOpenClawStateDatabaseAsync();
    resetFileLockStateForTest();
    resetPluginStateStoreForTests();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("concurrently persists and restores the selected prefix, replacing stale keys", async () => {
    const originalRuntime = getMatrixRuntime();
    const stateRuntime = { openKeyedStoreV2: originalRuntime.state.openKeyedStoreV2 };
    await seed();
    await seed(records("room-2", "should-not-restore"), otherCryptoDatabaseName);

    setMatrixRuntime({
      ...originalRuntime,
      state: {
        ...originalRuntime.state,
        openKeyedStoreV2: () => {
          throw new Error("ambient Matrix runtime is unavailable");
        },
      },
    });

    const persistSelected = () =>
      persistIdbToDisk({
        snapshotPath,
        databasePrefix: DATABASE_PREFIX,
        stateRuntime,
      });
    await Promise.all([persistSelected(), persistSelected()]);
    expect(fs.existsSync(snapshotPath)).toBe(false);

    await seed(records("stale", "old-owner"));

    expect(await restoreIdbFromDisk(snapshotPath, stateRuntime, DATABASE_PREFIX)).toBe(true);
    expect(await read()).toEqual(records("room-1", "abc123"));
    expect(await read(otherCryptoDatabaseName)).toEqual(records("room-2", "should-not-restore"));
  });

  it.each([
    "[]",
    "{}",
    "{",
    "metadata",
    "null metadata",
    "missing metadata",
    "missing chunk",
    "malformed chunk",
    "digest",
  ] as const)(
    "refuses invalid snapshot %j without deleting keys or replacing stored state",
    async (corruption) => {
      const retained = records("room-1", "retained-key");
      await seed(retained);
      const store = snapshotStore<Record<string, unknown> | null>();
      const invalidJson = ["[]", "{}", "{"].includes(corruption);
      if (invalidJson) {
        await write(corruption);
      } else {
        await persist(true);
        const meta = await store.lookup("current:meta");
        assert(meta && typeof meta.generation === "string", "expected published snapshot metadata");
        const chunkKey = `current:snapshot:${meta.generation}:0`;
        if (corruption === "missing metadata") {
          await store.delete("current:meta");
        } else if (corruption === "null metadata") {
          await store.register("current:meta", null);
        } else if (corruption === "missing chunk") {
          await store.delete(chunkKey);
        } else if (corruption === "malformed chunk") {
          await store.register(chunkKey, { ...(await store.lookup(chunkKey)), index: -1 });
        } else {
          await store.register(
            "current:meta",
            corruption === "metadata" ? { ...meta, version: 0 } : { ...meta, digest: "incorrect" },
          );
        }
      }
      const storedRows = await store.entries();

      await expect(restore()).rejects.toThrow();
      expect(await read()).toEqual(retained);
      await expect(persist(true)).rejects.toThrow();
      expect(await store.entries()).toEqual(storedRows);
      if (invalidJson) {
        expect(await readMatrixIdbSnapshotJson(tmpDir)).toBe(corruption);
      }
    },
  );

  it.each([
    ["invalid record key", "DataError", true, false],
    ["unique index conflict", "ConstraintError", false, false],
    ["invalid later database", "DataError", true, true],
  ] as const)(
    "preserves retained account keys after %s during replay",
    async (_failure, errorName, invalidKey, later) => {
      const retained = records("retained", "retained-key");
      const unrelated = records("other-room", "other-account-key");
      await seed(retained, cryptoDatabaseName, 3);
      await seed(unrelated, otherCryptoDatabaseName);
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
      await write(snapshotJson, snapshot.length);
      await expect(restore()).rejects.toMatchObject({ name: errorName });
      expect(await indexedDB.databases()).toEqual(databasesBefore);
      expect(await read(cryptoDatabaseName, 3)).toEqual(retained);
      expect(await read(otherCryptoDatabaseName)).toEqual(unrelated);
      expect(await readMatrixIdbSnapshotJson(tmpDir)).toBe(snapshotJson);
      await new Promise<void>((resolve, reject) => {
        const request = indexedDB.deleteDatabase(cryptoDatabaseName);
        void requestResult(request).then(() => resolve(), reject);
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
      const retained = records("retained", "retained-key");
      for (const name of [cryptoDatabaseName, otherCryptoDatabaseName]) {
        await seed(retained, name);
      }
      const snapshotJson = JSON.stringify([
        { name: cryptoDatabaseName, version: 1, stores: [] },
        {
          name: invalidName === "duplicate" ? cryptoDatabaseName : otherCryptoDatabaseName,
          version: 1,
          stores: [],
        },
      ]);
      await write(snapshotJson, 2);
      await expect(restore()).rejects.toThrow("Malformed IndexedDB snapshot database names");
      for (const name of [cryptoDatabaseName, otherCryptoDatabaseName]) {
        expect(await read(name)).toEqual(retained);
      }
      expect(await readMatrixIdbSnapshotJson(tmpDir)).toBe(snapshotJson);
    },
  );

  it("reassembles exact snapshot bytes beyond chunk 9", async () => {
    const snapshotJson = JSON.stringify({
      records: Array.from({ length: 24 }, (_, index) => `${index}:🦞${"x".repeat(15_000)}`),
    });
    await write(snapshotJson);
    const stateRuntime: MatrixSnapshotStateRuntime = {
      openKeyedStoreV2<T>(options: OpenAsyncKeyedStoreOptions) {
        return createPluginStateKeyedStoreForTests<T>("matrix", options);
      },
    };
    expect(await readMatrixIdbSnapshotJson(tmpDir)).toBe(snapshotJson);
    await expect(readMatrixIdbSnapshotJson(tmpDir, stateRuntime)).resolves.toBe(snapshotJson);
  });

  it("refuses retired snapshot JSON when canonical SQLite state is valid", async () => {
    const snapshot = JSON.stringify([{ name: cryptoDatabaseName, version: 1, stores: [] }]);
    const canonicalSnapshot = JSON.stringify([
      { name: otherCryptoDatabaseName, version: 1, stores: [] },
    ]);
    await write(canonicalSnapshot);
    fs.writeFileSync(snapshotPath, snapshot);
    const remediation =
      'Install OpenClaw 2026.9.5, run "openclaw doctor --fix", and start the Matrix channel once to migrate it, then upgrade to latest.';
    const diagnostic = { code: "matrix-idb-snapshot-requires-doctor", remediation };

    await expect(restoreIdbFromDisk(snapshotPath)).rejects.toMatchObject({
      name: "MatrixIdbSnapshotMigrationRequiredError",
      ...diagnostic,
    });
    expect(warnSpy).toHaveBeenCalledWith("IdbPersistence", expect.objectContaining(diagnostic));
    expect(JSON.stringify(warnSpy.mock.calls)).not.toContain(snapshotPath);
    const databaseNames = (await indexedDB.databases()).map((database) => database.name);
    expect(databaseNames).not.toContain(cryptoDatabaseName);
    expect(databaseNames).not.toContain(otherCryptoDatabaseName);

    await seed(records("new-room", "new"));
    await expect(persist()).rejects.toMatchObject(diagnostic);
    expect(await readMatrixIdbSnapshotJson(tmpDir)).toBe(canonicalSnapshot);
    expect(fs.readFileSync(snapshotPath, "utf8")).toBe(snapshot);

    vi.spyOn(getMatrixRuntime().state, "openKeyedStoreV2").mockImplementation(() => {
      throw new Error("sqlite unavailable");
    });
    await expect(restoreIdbFromDisk(snapshotPath)).rejects.toMatchObject(diagnostic);
  });

  it("returns false without warning when the snapshot does not exist yet", async () => {
    expect(await restoreIdbFromDisk(snapshotPath)).toBe(false);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("strictly propagates final IndexedDB persistence failures", async () => {
    const cause = new Error("indexeddb unavailable");
    vi.spyOn(indexedDB, "databases").mockRejectedValue(cause);
    await expect(persist(true)).rejects.toBe(cause);
  });

  it("cancels an active snapshot before writing without warning", async () => {
    await seed();
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
    }
  });
});
