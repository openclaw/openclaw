import "fake-indexeddb/auto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const DB_NAME = "openclaw-fake-idb-cleanup-test";

/**
 * Regression test for issue #90455: finished IndexedDB transactions
 * retained in fake-indexeddb's internal transactions array, causing
 * unbounded heap growth under Matrix E2EE usage.
 */
describe("fake-indexeddb transaction cleanup", () => {
  beforeAll(async () => {
    await deleteDatabase(DB_NAME);
  });

  afterAll(async () => {
    await deleteDatabase(DB_NAME);
  });

  it("removes finished transactions from the internal array after commit", async () => {
    const db = await openWithStore(DB_NAME, "test");

    const rawDb = (db as unknown as { _rawDatabase: { transactions: unknown[] } })._rawDatabase;
    expect(rawDb.transactions).toHaveLength(0);

    // Run several transactions sequentially
    for (let i = 0; i < 5; i++) {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction("test", "readwrite");
        tx.objectStore("test").put({ val: i }, `key-${i}`);
        tx.addEventListener("complete", () => resolve(), { once: true });
        tx.addEventListener("error", () => reject(tx.error), { once: true });
      });
    }

    // After all transactions complete, the internal array must be empty
    // (the patch prunes finished transactions in processTransactions)
    expect(rawDb.transactions).toHaveLength(0);
  });

  it("removes finished transactions from the internal array after abort", async () => {
    const db = await openWithStore(DB_NAME, "test");

    const rawDb = (db as unknown as { _rawDatabase: { transactions: unknown[] } })._rawDatabase;
    expect(rawDb.transactions).toHaveLength(0);

    // Open and abort a transaction
    const tx1 = db.transaction("test", "readwrite");
    tx1.objectStore("test").put({ val: 1 }, "key-1");
    tx1.abort();

    // In real usage, another transaction follows and triggers processTransactions which prunes finished ones
    const tx2 = db.transaction("test", "readwrite");

    // The aborted (finished) transaction should be pruned when a new transaction is opened
    expect(rawDb.transactions).toHaveLength(1);
    // Only tx2 remains
    expect(rawDb.transactions[0]).toBe(tx2);

    // Clean up: wait for tx2 to be pruned too
    await new Promise<void>((resolve) => {
      tx2.addEventListener("complete", () => resolve(), { once: true });
    });
    expect(rawDb.transactions).toHaveLength(0);
  });
});

function openWithStore(name: string, storeName: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name, 1);
    req.addEventListener("upgradeneeded", () => {
      if (!req.result.objectStoreNames.contains(storeName)) {
        req.result.createObjectStore(storeName);
      }
    });
    req.addEventListener("success", () => resolve(req.result), { once: true });
    req.addEventListener("error", () => reject(req.error), { once: true });
  });
}

function deleteDatabase(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(name);
    req.addEventListener("success", () => resolve(), { once: true });
    req.addEventListener("blocked", () => resolve(), { once: true });
    req.addEventListener("error", () => reject(req.error), { once: true });
  });
}
