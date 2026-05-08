import "fake-indexeddb/auto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createPluginBlobStore,
  resetPluginBlobStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MATRIX_IDB_SNAPSHOT_NAMESPACE,
  persistIdbToState,
  resolveMatrixIdbSnapshotKey,
  restoreIdbFromState,
} from "./idb-persistence.js";
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

  function snapshotPath(name: string): string {
    return path.join(tmpDir, "state", "matrix", name);
  }

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "matrix-idb-persist-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", path.join(tmpDir, "state"));
    warnSpy = vi.spyOn(LogService, "warn").mockImplementation(() => {});
    await clearTestIndexedDbState();
  });

  afterEach(async () => {
    warnSpy.mockRestore();
    await clearTestIndexedDbState();
    resetPluginBlobStoreForTests();
    vi.unstubAllEnvs();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("persists and restores database contents for the selected prefix", async () => {
    const snapshot = snapshotPath("crypto-idb-snapshot.json");
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

    await persistIdbToState({
      snapshotPath: snapshot,
      databasePrefix: DATABASE_PREFIX,
    });
    expect(fs.existsSync(snapshot)).toBe(false);

    await clearTestIndexedDbState();

    const restored = await restoreIdbFromState(snapshot);
    expect(restored).toBe(true);

    const restoredRecords = await readDatabaseRecords({
      name: cryptoDatabaseName,
      storeName: "sessions",
    });
    expect(restoredRecords).toEqual([{ key: "room-1", value: { session: "abc123" } }]);

    const dbs = await indexedDB.databases();
    expect(dbs.map((entry) => entry.name)).not.toContain(otherCryptoDatabaseName);
  });

  it("returns false and logs a warning for malformed snapshots", async () => {
    const snapshot = snapshotPath("bad-snapshot.json");
    const store = createPluginBlobStore("matrix", {
      namespace: MATRIX_IDB_SNAPSHOT_NAMESPACE,
      maxEntries: 1_000,
    });
    await store.register(
      resolveMatrixIdbSnapshotKey(snapshot),
      { version: 1, persistedAt: new Date().toISOString() },
      Buffer.from(JSON.stringify([{ nope: true }])),
    );

    const restored = await restoreIdbFromState(snapshot);
    expect(restored).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(
      "IdbPersistence",
      "Failed to restore IndexedDB snapshot from SQLite state:",
      expect.any(Error),
    );
  });

  it("returns false for empty snapshot payloads without restoring databases", async () => {
    const snapshot = snapshotPath("empty-snapshot.json");
    const store = createPluginBlobStore("matrix", {
      namespace: MATRIX_IDB_SNAPSHOT_NAMESPACE,
      maxEntries: 1_000,
    });
    await store.register(
      resolveMatrixIdbSnapshotKey(snapshot),
      { version: 1, persistedAt: new Date().toISOString() },
      Buffer.from(JSON.stringify([])),
    );

    const restored = await restoreIdbFromState(snapshot);
    expect(restored).toBe(false);

    const dbs = await indexedDB.databases();
    expect(dbs).toStrictEqual([]);
  });

  it("returns false without warning when the snapshot does not exist yet", async () => {
    const restored = await restoreIdbFromState(snapshotPath("missing-snapshot.json"));

    expect(restored).toBe(false);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("handles concurrent persist operations through SQLite state", async () => {
    const snapshot = snapshotPath("concurrent-persist.json");
    await seedDatabase({
      name: cryptoDatabaseName,
      storeName: "sessions",
      records: [{ key: "room-1", value: { session: "abc123" } }],
    });

    await Promise.all([
      persistIdbToState({ snapshotPath: snapshot, databasePrefix: DATABASE_PREFIX }),
      persistIdbToState({ snapshotPath: snapshot, databasePrefix: DATABASE_PREFIX }),
    ]);

    expect(fs.existsSync(snapshot)).toBe(false);

    await clearTestIndexedDbState();

    expect(await restoreIdbFromState(snapshot)).toBe(true);

    const restoredRecords = await readDatabaseRecords({
      name: cryptoDatabaseName,
      storeName: "sessions",
    });
    expect(restoredRecords).toEqual([{ key: "room-1", value: { session: "abc123" } }]);
  });
});
