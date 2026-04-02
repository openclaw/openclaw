import "fake-indexeddb/auto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const { withFileLockMock } = vi.hoisted(() => ({
  withFileLockMock: vi.fn(
    async <T>(_filePath: string, _options: unknown, fn: () => Promise<T>) => await fn(),
  ),
}));

vi.mock("openclaw/plugin-sdk/infra-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/infra-runtime")>();
  return {
    ...actual,
    withFileLock: withFileLockMock,
  };
});

let persistIdbToDisk: typeof import("./idb-persistence.js").persistIdbToDisk;

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

beforeAll(async () => {
  ({ persistIdbToDisk } = await import("./idb-persistence.js"));
});

describe("Matrix IndexedDB persistence lock ordering", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "matrix-idb-lock-order-"));
    withFileLockMock.mockReset();
    withFileLockMock.mockImplementation(
      async <T>(_filePath: string, _options: unknown, fn: () => Promise<T>) => await fn(),
    );
    await clearAllIndexedDbState();
  });

  afterEach(async () => {
    await clearAllIndexedDbState();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("captures the snapshot after the file lock is acquired", async () => {
    const snapshotPath = path.join(tmpDir, "crypto-idb-snapshot.json");
    const dbName = "openclaw-matrix-test::matrix-sdk-crypto";
    await seedDatabase({
      name: dbName,
      storeName: "sessions",
      records: [{ key: "room-1", value: { session: "old-session" } }],
    });

    withFileLockMock.mockImplementationOnce(async (_filePath, _options, fn) => {
      await seedDatabase({
        name: dbName,
        storeName: "sessions",
        records: [{ key: "room-1", value: { session: "new-session" } }],
      });
      return await fn();
    });

    await persistIdbToDisk({ snapshotPath, databasePrefix: "openclaw-matrix-test" });

    const data = JSON.parse(fs.readFileSync(snapshotPath, "utf8")) as Array<{
      stores: Array<{
        name: string;
        records: Array<{ key: IDBValidKey; value: { session: string } }>;
      }>;
    }>;
    const sessionsStore = data[0]?.stores.find((store) => store.name === "sessions");
    expect(sessionsStore?.records).toEqual([{ key: "room-1", value: { session: "new-session" } }]);
  });
});
