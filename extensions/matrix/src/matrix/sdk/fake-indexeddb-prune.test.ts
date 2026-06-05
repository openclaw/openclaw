// Matrix tests cover fake-indexeddb transaction pruning for crypto stores.
import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import {
  installFakeIndexedDbTransactionPruner,
  pruneFinishedFakeIndexedDbTransactions,
} from "./fake-indexeddb-prune.js";

function openDatabase(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore("sessions", { keyPath: "key" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function deleteDatabase(name: string): Promise<void> {
  return new Promise((resolve) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () => resolve();
    request.onblocked = () => resolve();
  });
}

function putRecord(db: IDBDatabase, key: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction("sessions", "readwrite");
    transaction.objectStore("sessions").put({ key, value: "payload" });
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error ?? new Error("transaction aborted"));
  });
}

function rawTransactions(db: IDBDatabase): Array<{ _state?: string }> {
  return ((db as unknown as { _rawDatabase?: { transactions?: Array<{ _state?: string }> } })._rawDatabase?.transactions ?? []);
}

describe("Matrix fake-indexeddb transaction pruning", () => {
  const databaseNames = new Set<string>();

  afterEach(async () => {
    for (const name of databaseNames) {
      await deleteDatabase(name);
    }
    databaseNames.clear();
  });

  it("prunes finished transactions for Matrix crypto databases", async () => {
    installFakeIndexedDbTransactionPruner();
    const databaseName = `openclaw-matrix-prune-test-${Date.now()}::matrix-sdk-crypto`;
    databaseNames.add(databaseName);
    const db = await openDatabase(databaseName);

    for (let i = 0; i < 5; i += 1) {
      await putRecord(db, `key-${i}`);
    }

    expect(rawTransactions(db)).toHaveLength(0);
    db.close();
  });

  it("does not prune unrelated fake-indexeddb databases", async () => {
    installFakeIndexedDbTransactionPruner();
    const databaseName = `openclaw-matrix-unrelated-prune-test-${Date.now()}`;
    databaseNames.add(databaseName);
    const db = await openDatabase(databaseName);

    await putRecord(db, "key-1");

    expect(rawTransactions(db).filter((transaction) => transaction._state === "finished").length).toBeGreaterThan(0);
    db.close();
  });

  it("keeps active transactions when pruning the raw transaction queue", () => {
    const rawDatabase = {
      name: "openclaw-matrix-direct-prune-test::matrix-sdk-crypto",
      transactions: [{ _state: "finished" }, { _state: "active" }, { _state: "inactive" }],
    };

    expect(pruneFinishedFakeIndexedDbTransactions(rawDatabase)).toBe(1);
    expect(rawDatabase.transactions).toEqual([{ _state: "active" }, { _state: "inactive" }]);
  });
});
