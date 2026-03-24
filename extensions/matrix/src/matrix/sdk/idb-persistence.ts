import fs from "node:fs";
import path from "node:path";
import { indexedDB as fakeIndexedDB } from "fake-indexeddb";
import { LogService } from "./logger.js";

type IdbStoreSnapshot = {
  name: string;
  keyPath: IDBObjectStoreParameters["keyPath"];
  autoIncrement: boolean;
  indexes: { name: string; keyPath: string | string[]; multiEntry: boolean; unique: boolean }[];
  records: { key: IDBValidKey; value: unknown }[];
};

type IdbDatabaseSnapshot = {
  name: string;
  version: number;
  stores: IdbStoreSnapshot[];
};

function isValidIdbIndexSnapshot(value: unknown): value is IdbStoreSnapshot["indexes"][number] {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<IdbStoreSnapshot["indexes"][number]>;
  return (
    typeof candidate.name === "string" &&
    (typeof candidate.keyPath === "string" ||
      (Array.isArray(candidate.keyPath) &&
        candidate.keyPath.every((entry) => typeof entry === "string"))) &&
    typeof candidate.multiEntry === "boolean" &&
    typeof candidate.unique === "boolean"
  );
}

function isValidIdbRecordSnapshot(value: unknown): value is IdbStoreSnapshot["records"][number] {
  if (!value || typeof value !== "object") {
    return false;
  }
  return "key" in value && "value" in value;
}

function isValidIdbStoreSnapshot(value: unknown): value is IdbStoreSnapshot {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<IdbStoreSnapshot>;
  const validKeyPath =
    candidate.keyPath === null ||
    typeof candidate.keyPath === "string" ||
    (Array.isArray(candidate.keyPath) &&
      candidate.keyPath.every((entry) => typeof entry === "string"));
  return (
    typeof candidate.name === "string" &&
    validKeyPath &&
    typeof candidate.autoIncrement === "boolean" &&
    Array.isArray(candidate.indexes) &&
    candidate.indexes.every((entry) => isValidIdbIndexSnapshot(entry)) &&
    Array.isArray(candidate.records) &&
    candidate.records.every((entry) => isValidIdbRecordSnapshot(entry))
  );
}

function isValidIdbDatabaseSnapshot(value: unknown): value is IdbDatabaseSnapshot {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<IdbDatabaseSnapshot>;
  return (
    typeof candidate.name === "string" &&
    typeof candidate.version === "number" &&
    Number.isFinite(candidate.version) &&
    candidate.version > 0 &&
    Array.isArray(candidate.stores) &&
    candidate.stores.every((entry) => isValidIdbStoreSnapshot(entry))
  );
}

function parseSnapshotPayload(data: string): IdbDatabaseSnapshot[] | null {
  const parsed = JSON.parse(data) as unknown;
  if (!Array.isArray(parsed) || parsed.length === 0) {
    return null;
  }
  if (!parsed.every((entry) => isValidIdbDatabaseSnapshot(entry))) {
    throw new Error("Malformed IndexedDB snapshot payload");
  }
  return parsed;
}

function idbReq<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function dumpIndexedDatabases(databasePrefix?: string): Promise<IdbDatabaseSnapshot[]> {
  const idb = fakeIndexedDB;
  const dbList = await idb.databases();
  const snapshot: IdbDatabaseSnapshot[] = [];
  const expectedPrefix = databasePrefix ? `${databasePrefix}::` : null;

  for (const { name, version } of dbList) {
    if (!name || !version) continue;
    if (expectedPrefix && !name.startsWith(expectedPrefix)) continue;
    const db: IDBDatabase = await new Promise((resolve, reject) => {
      const r = idb.open(name, version);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });

    const stores: IdbStoreSnapshot[] = [];
    for (const storeName of db.objectStoreNames) {
      const tx = db.transaction(storeName, "readonly");
      const store = tx.objectStore(storeName);
      const storeInfo: IdbStoreSnapshot = {
        name: storeName,
        keyPath: store.keyPath as IDBObjectStoreParameters["keyPath"],
        autoIncrement: store.autoIncrement,
        indexes: [],
        records: [],
      };
      for (const idxName of store.indexNames) {
        const idx = store.index(idxName);
        storeInfo.indexes.push({
          name: idxName,
          keyPath: idx.keyPath as string | string[],
          multiEntry: idx.multiEntry,
          unique: idx.unique,
        });
      }
      const keys = await idbReq(store.getAllKeys());
      const values = await idbReq(store.getAll());
      storeInfo.records = keys.map((k, i) => ({ key: k, value: values[i] }));
      stores.push(storeInfo);
    }
    snapshot.push({ name, version, stores });
    db.close();
  }
  return snapshot;
}

async function restoreIndexedDatabases(snapshot: IdbDatabaseSnapshot[]): Promise<void> {
  const idb = fakeIndexedDB;
  for (const dbSnap of snapshot) {
    await new Promise<void>((resolve, reject) => {
      const r = idb.open(dbSnap.name, dbSnap.version);
      r.onupgradeneeded = () => {
        const db = r.result;
        for (const storeSnap of dbSnap.stores) {
          const opts: IDBObjectStoreParameters = {};
          if (storeSnap.keyPath !== null) opts.keyPath = storeSnap.keyPath;
          if (storeSnap.autoIncrement) opts.autoIncrement = true;
          const store = db.createObjectStore(storeSnap.name, opts);
          for (const idx of storeSnap.indexes) {
            store.createIndex(idx.name, idx.keyPath, {
              unique: idx.unique,
              multiEntry: idx.multiEntry,
            });
          }
        }
      };
      r.onsuccess = async () => {
        try {
          const db = r.result;
          for (const storeSnap of dbSnap.stores) {
            if (storeSnap.records.length === 0) continue;
            const tx = db.transaction(storeSnap.name, "readwrite");
            const store = tx.objectStore(storeSnap.name);
            for (const rec of storeSnap.records) {
              if (storeSnap.keyPath !== null) {
                store.put(rec.value);
              } else {
                store.put(rec.value, rec.key);
              }
            }
            await new Promise<void>((res) => {
              tx.oncomplete = () => res();
            });
          }
          db.close();
          resolve();
        } catch (err) {
          reject(err);
        }
      };
      r.onerror = () => reject(r.error);
    });
  }
}

function resolveDefaultIdbSnapshotPath(): string {
  const stateDir =
    process.env.OPENCLAW_STATE_DIR || path.join(process.env.HOME || "/tmp", ".openclaw");
  return path.join(stateDir, "matrix", "crypto-idb-snapshot.json");
}

export async function restoreIdbFromDisk(snapshotPath?: string): Promise<boolean> {
  const candidatePaths = snapshotPath ? [snapshotPath] : [resolveDefaultIdbSnapshotPath()];
  for (const resolvedPath of candidatePaths) {
    try {
      const data = fs.readFileSync(resolvedPath, "utf8");
      const snapshot = parseSnapshotPayload(data);
      if (!snapshot) {
        continue;
      }
      await restoreIndexedDatabases(snapshot);
      LogService.info(
        "IdbPersistence",
        `Restored ${snapshot.length} IndexedDB database(s) from ${resolvedPath}`,
      );
      return true;
    } catch (err) {
      LogService.warn(
        "IdbPersistence",
        `Failed to restore IndexedDB snapshot from ${resolvedPath}:`,
        err,
      );
      continue;
    }
  }
  return false;
}

export async function persistIdbToDisk(params?: {
  snapshotPath?: string;
  databasePrefix?: string;
}): Promise<void> {
  const snapshotPath = params?.snapshotPath ?? resolveDefaultIdbSnapshotPath();
  try {
    const snapshot = await dumpIndexedDatabases(params?.databasePrefix);
    if (snapshot.length === 0) return;
    fs.mkdirSync(path.dirname(snapshotPath), { recursive: true });
    fs.writeFileSync(snapshotPath, JSON.stringify(snapshot));
    fs.chmodSync(snapshotPath, 0o600);
    LogService.debug(
      "IdbPersistence",
      `Persisted ${snapshot.length} IndexedDB database(s) to ${snapshotPath}`,
    );
  } catch (err) {
    LogService.warn("IdbPersistence", "Failed to persist IndexedDB snapshot:", err);
  }
}
