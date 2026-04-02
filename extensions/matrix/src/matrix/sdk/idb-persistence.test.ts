import "fake-indexeddb/auto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { persistIdbToDisk, restoreIdbFromDisk } from "./idb-persistence.js";
import { LogService } from "./logger.js";

async function clearAllIndexedDbState(): Promise<void> {
  const databases = await indexedDB.databases();
  await Promise.all(
    databases
      .map((entry) => entry.name)
      .filter((name): name is string => Boolean(name))
      .map(
        (name) =>
          new Promise<void>((resolve, reject) => {
            const req = indexedDB.deleteDatabase(name);
            req.onsuccess = () => resolve();
            req.onerror = () => reject(req.error);
            req.onblocked = () => resolve();
          }),
      ),
  );
}

async function seedDatabase(params: {
  name: string;
  version?: number;
  storeName: string;
  records: Array<{ key: IDBValidKey; value: unknown }>;
}): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.open(params.name, params.version ?? 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(params.storeName)) {
        db.createObjectStore(params.storeName);
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction(params.storeName, "readwrite");
      const store = tx.objectStore(params.storeName);
      for (const record of params.records) {
        store.put(record.value, record.key);
      }
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => reject(tx.error);
    };
    req.onerror = () => reject(req.error);
  });
}

async function readDatabaseRecords(params: {
  name: string;
  version?: number;
  storeName: string;
}): Promise<Array<{ key: IDBValidKey; value: unknown }>> {
  return await new Promise((resolve, reject) => {
    const req = indexedDB.open(params.name, params.version ?? 1);
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction(params.storeName, "readonly");
      const store = tx.objectStore(params.storeName);
      const keysReq = store.getAllKeys();
      const valuesReq = store.getAll();
      let keys: IDBValidKey[] | null = null;
      let values: unknown[] | null = null;

      const maybeResolve = () => {
        if (!keys || !values) {
          return;
        }
        db.close();
        const resolvedValues = values;
        resolve(keys.map((key, index) => ({ key, value: resolvedValues[index] })));
      };

      keysReq.onsuccess = () => {
        keys = keysReq.result;
        maybeResolve();
      };
      valuesReq.onsuccess = () => {
        values = valuesReq.result;
        maybeResolve();
      };
      keysReq.onerror = () => reject(keysReq.error);
      valuesReq.onerror = () => reject(valuesReq.error);
    };
    req.onerror = () => reject(req.error);
  });
}

describe("Matrix IndexedDB persistence", () => {
  let tmpDir: string;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "matrix-idb-persist-"));
    warnSpy = vi.spyOn(LogService, "warn").mockImplementation(() => {});
    await clearAllIndexedDbState();
  });

  afterEach(async () => {
    warnSpy.mockRestore();
    await clearAllIndexedDbState();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("persists and restores database contents for the selected prefix", async () => {
    const snapshotPath = path.join(tmpDir, "crypto-idb-snapshot.json");
    await seedDatabase({
      name: "openclaw-matrix-test::matrix-sdk-crypto",
      storeName: "sessions",
      records: [{ key: "room-1", value: { session: "abc123" } }],
    });
    await seedDatabase({
      name: "other-prefix::matrix-sdk-crypto",
      storeName: "sessions",
      records: [{ key: "room-2", value: { session: "should-not-restore" } }],
    });

    await persistIdbToDisk({
      snapshotPath,
      databasePrefix: "openclaw-matrix-test",
    });
    expect(fs.existsSync(snapshotPath)).toBe(true);

    const mode = fs.statSync(snapshotPath).mode & 0o777;
    expect(mode).toBe(0o600);

    await clearAllIndexedDbState();

    const restored = await restoreIdbFromDisk(snapshotPath);
    expect(restored).toBe(true);

    const restoredRecords = await readDatabaseRecords({
      name: "openclaw-matrix-test::matrix-sdk-crypto",
      storeName: "sessions",
    });
    expect(restoredRecords).toEqual([{ key: "room-1", value: { session: "abc123" } }]);

    const dbs = await indexedDB.databases();
    expect(dbs.some((entry) => entry.name === "other-prefix::matrix-sdk-crypto")).toBe(false);
  });

  it("returns false and logs a warning for malformed snapshots", async () => {
    const snapshotPath = path.join(tmpDir, "bad-snapshot.json");
    fs.writeFileSync(snapshotPath, JSON.stringify([{ nope: true }]), "utf8");

    const restored = await restoreIdbFromDisk(snapshotPath);
    expect(restored).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(
      "IdbPersistence",
      expect.stringContaining(`Failed to restore IndexedDB snapshot from ${snapshotPath}:`),
      expect.any(Error),
    );
  });

  it("returns false for empty snapshot payloads without restoring databases", async () => {
    const snapshotPath = path.join(tmpDir, "empty-snapshot.json");
    fs.writeFileSync(snapshotPath, JSON.stringify([]), "utf8");

    const restored = await restoreIdbFromDisk(snapshotPath);
    expect(restored).toBe(false);

    const dbs = await indexedDB.databases();
    expect(dbs).toEqual([]);
  });
});
