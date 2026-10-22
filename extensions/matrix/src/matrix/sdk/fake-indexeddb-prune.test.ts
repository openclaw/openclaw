import "fake-indexeddb/auto";
import { afterEach, expect, it } from "vitest";
import { installFakeIndexedDbTransactionPruner } from "./fake-indexeddb-prune.js";
import { requestResult } from "./idb-persistence.test-helpers.js";

function openDatabase(name: string) {
  const request = indexedDB.open(name, 1);
  request.addEventListener("upgradeneeded", () => {
    request.result.createObjectStore("sessions", { keyPath: "key" });
  });
  return requestResult(request);
}

function deleteDatabase(name: string): Promise<void> {
  return new Promise((resolve) => {
    const request = indexedDB.deleteDatabase(name);
    for (const event of ["success", "error", "blocked"]) {
      request.addEventListener(event, () => resolve(), { once: true });
    }
  });
}

function putRecord(db: IDBDatabase, key: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction("sessions", "readwrite");
    transaction.objectStore("sessions").put({ key, value: "payload" });
    transaction.addEventListener("complete", () => resolve(), { once: true });
    for (const event of ["error", "abort"]) {
      transaction.addEventListener(
        event,
        () => reject(transaction.error ?? new Error(`transaction ${event}`)),
        { once: true },
      );
    }
  });
}

const databaseNames = new Set<string>();

afterEach(async () => {
  for (const name of databaseNames) {
    await deleteDatabase(name);
  }
  databaseNames.clear();
});

it.each(["::matrix-sdk-crypto", "::matrix-sdk-crypto-meta", ""])(
  "prunes finished transactions only for Matrix crypto databases (suffix: %s)",
  async (suffix) => {
    installFakeIndexedDbTransactionPruner();
    const databaseName = `openclaw-matrix-prune-test-${Date.now()}${suffix}`;
    databaseNames.add(databaseName);
    const db = await openDatabase(databaseName);

    for (let i = 0; i < (suffix ? 5 : 1); i += 1) {
      await putRecord(db, `key-${i}`);
    }

    const transactions = (
      db as unknown as { _rawDatabase: { transactions: Array<{ _state: string }> } }
    )["_rawDatabase"].transactions;
    if (suffix) {
      expect(transactions).toHaveLength(0);
    } else {
      expect(
        transactions.filter((transaction) => transaction["_state"] === "finished").length,
      ).toBeGreaterThan(0);
    }
    db.close();
  },
);
