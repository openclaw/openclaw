import fs from "node:fs";
import path from "node:path";
import { IDBFactory, indexedDB as fakeIndexedDB } from "fake-indexeddb";
import { toErrorObject } from "openclaw/plugin-sdk/error-runtime";
import { withFileLock } from "openclaw/plugin-sdk/file-lock";
import { asOptionalObjectRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { getMatrixRuntime } from "../../runtime.js";
import {
  readMatrixIdbSnapshotJson,
  type MatrixSnapshotStateRuntime,
  writeMatrixIdbSnapshotJson,
} from "../crypto-state-store.js";
import { RETIRED_MATRIX_STATE_REMEDIATION } from "../retired-state.js";
import { MATRIX_IDB_SNAPSHOT_LOCK_OPTIONS } from "./idb-persistence-lock.js";
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

const LEGACY_SNAPSHOT_DIAGNOSTIC = {
  code: "matrix-idb-snapshot-requires-doctor",
  message: "Matrix IndexedDB snapshot exists outside canonical SQLite state",
  remediation: RETIRED_MATRIX_STATE_REMEDIATION,
} as const;

class MatrixIdbSnapshotMigrationRequiredError extends Error {
  readonly code = LEGACY_SNAPSHOT_DIAGNOSTIC.code;
  readonly remediation = LEGACY_SNAPSHOT_DIAGNOSTIC.remediation;

  constructor() {
    super(`${LEGACY_SNAPSHOT_DIAGNOSTIC.message}; ${LEGACY_SNAPSHOT_DIAGNOSTIC.remediation}`);
    this.name = "MatrixIdbSnapshotMigrationRequiredError";
  }
}

function isValidIdbIndexSnapshot(value: unknown): value is IdbStoreSnapshot["indexes"][number] {
  const candidate = asOptionalObjectRecord(value);
  return (
    typeof candidate?.name === "string" &&
    (typeof candidate.keyPath === "string" ||
      (Array.isArray(candidate.keyPath) &&
        candidate.keyPath.every((entry) => typeof entry === "string"))) &&
    typeof candidate.multiEntry === "boolean" &&
    typeof candidate.unique === "boolean"
  );
}

function isValidIdbRecordSnapshot(value: unknown): value is IdbStoreSnapshot["records"][number] {
  const candidate = asOptionalObjectRecord(value);
  return Boolean(candidate && "key" in candidate && "value" in candidate);
}

function isValidIdbStoreSnapshot(value: unknown): value is IdbStoreSnapshot {
  const candidate = asOptionalObjectRecord(value);
  const keyPath = candidate?.keyPath;
  const validKeyPath =
    keyPath === null ||
    typeof keyPath === "string" ||
    (Array.isArray(keyPath) && keyPath.every((entry) => typeof entry === "string"));
  return (
    typeof candidate?.name === "string" &&
    validKeyPath &&
    typeof candidate.autoIncrement === "boolean" &&
    Array.isArray(candidate.indexes) &&
    candidate.indexes.every((entry) => isValidIdbIndexSnapshot(entry)) &&
    Array.isArray(candidate.records) &&
    candidate.records.every((entry) => isValidIdbRecordSnapshot(entry))
  );
}

function isValidIdbDatabaseSnapshot(value: unknown): value is IdbDatabaseSnapshot {
  const candidate = asOptionalObjectRecord(value);
  return (
    typeof candidate?.name === "string" &&
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

export function isValidMatrixIdbSnapshotJson(data: string): boolean {
  try {
    return parseSnapshotPayload(data) !== null;
  } catch {
    return false;
  }
}

function idbReq<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.addEventListener("success", () => resolve(req.result), { once: true });
    req.addEventListener("error", () => reject(toErrorObject(req.error, "Non-Error rejection")), {
      once: true,
    });
  });
}

async function dumpIndexedDatabases(databasePrefix?: string): Promise<IdbDatabaseSnapshot[]> {
  const idb = fakeIndexedDB;
  const dbList = await idb.databases();
  const snapshot: IdbDatabaseSnapshot[] = [];
  const expectedPrefix = databasePrefix ? `${databasePrefix}::` : null;

  for (const { name, version } of dbList) {
    if (!name || !version) {
      continue;
    }
    if (expectedPrefix && !name.startsWith(expectedPrefix)) {
      continue;
    }
    const db = await idbReq(idb.open(name, version));

    const stores: IdbStoreSnapshot[] = [];
    for (const storeName of db.objectStoreNames) {
      const tx = db.transaction(storeName, "readonly");
      const store = tx.objectStore(storeName);
      const storeInfo: IdbStoreSnapshot = {
        name: storeName,
        keyPath: store.keyPath,
        autoIncrement: store.autoIncrement,
        indexes: [],
        records: [],
      };
      for (const idxName of store.indexNames) {
        const idx = store.index(idxName);
        storeInfo.indexes.push({
          name: idxName,
          keyPath: idx.keyPath,
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

async function clearAccountIndexedDatabases(databasePrefix?: string): Promise<void> {
  if (!databasePrefix) {
    return;
  }
  const names = await fakeIndexedDB.databases();
  for (const { name } of names) {
    if (name?.startsWith(`${databasePrefix}::`)) {
      await idbReq(fakeIndexedDB.deleteDatabase(name));
    }
  }
}

async function restoreIndexedDatabases(
  snapshot: IdbDatabaseSnapshot[],
  idb: IDBFactory,
): Promise<void> {
  for (const dbSnap of snapshot) {
    const request = idb.open(dbSnap.name, dbSnap.version);
    request.addEventListener("upgradeneeded", () => {
      const db = request.result;
      for (const storeSnap of dbSnap.stores) {
        const opts: IDBObjectStoreParameters = {};
        if (storeSnap.keyPath !== null) {
          opts.keyPath = storeSnap.keyPath;
        }
        if (storeSnap.autoIncrement) {
          opts.autoIncrement = true;
        }
        const store = db.createObjectStore(storeSnap.name, opts);
        for (const idx of storeSnap.indexes) {
          store.createIndex(idx.name, idx.keyPath, {
            unique: idx.unique,
            multiEntry: idx.multiEntry,
          });
        }
      }
    });
    const db = await idbReq(request);
    try {
      for (const storeSnap of dbSnap.stores) {
        if (storeSnap.records.length === 0) {
          continue;
        }
        const tx = db.transaction(storeSnap.name, "readwrite");
        await new Promise<void>((resolve, reject) => {
          let enqueueError: unknown;
          tx.addEventListener("complete", () => resolve(), { once: true });
          tx.addEventListener(
            "abort",
            () =>
              reject(
                enqueueError ?? toErrorObject(tx.error, "IndexedDB restore transaction aborted"),
              ),
            { once: true },
          );
          try {
            const store = tx.objectStore(storeSnap.name);
            for (const rec of storeSnap.records) {
              if (storeSnap.keyPath !== null) {
                store.put(rec.value);
              } else {
                store.put(rec.value, rec.key);
              }
            }
          } catch (err) {
            // A synchronous put failure must also settle earlier queued writes.
            enqueueError = err;
            tx.abort();
          }
        });
      }
    } finally {
      db.close();
    }
  }
}

export function resolveDefaultIdbSnapshotPath(): string {
  const stateDir =
    process.env.OPENCLAW_STATE_DIR || path.join(process.env.HOME || "/tmp", ".openclaw");
  return path.join(stateDir, "matrix", "crypto-idb-snapshot.json");
}

async function readCanonicalSnapshot(
  snapshotPath: string,
  stateRuntime: MatrixSnapshotStateRuntime,
): Promise<IdbDatabaseSnapshot[] | null> {
  throwIfLegacySnapshotNeedsDoctor(snapshotPath);
  const snapshotJson = await readMatrixIdbSnapshotJson(path.dirname(snapshotPath), stateRuntime);
  if (snapshotJson === null) {
    return null;
  }
  const snapshot = parseSnapshotPayload(snapshotJson);
  if (!snapshot) {
    throw new Error("Malformed IndexedDB snapshot payload");
  }
  return snapshot;
}

// Production callers pass MatrixStoragePaths.idbSnapshotPath; explicit paths only isolate tests.
export async function restoreIdbFromDisk(
  snapshotPath?: string,
  stateRuntime?: MatrixSnapshotStateRuntime,
  databasePrefix?: string,
): Promise<boolean> {
  const resolvedPath = snapshotPath ?? resolveDefaultIdbSnapshotPath();
  let callbackStarted = false;
  try {
    const snapshotStateRuntime = stateRuntime ?? getMatrixRuntime().state;
    // withFileLock is acquire-or-throw; it never skips the callback on contention.
    return await withFileLock(resolvedPath, MATRIX_IDB_SNAPSHOT_LOCK_OPTIONS, async () => {
      callbackStarted = true;
      const snapshot = await readCanonicalSnapshot(resolvedPath, snapshotStateRuntime);
      if (snapshot === null) {
        await clearAccountIndexedDatabases(databasePrefix);
        return false;
      }
      const names = new Set<string>();
      for (const { name } of snapshot) {
        if (names.has(name) || (databasePrefix && !name.startsWith(`${databasePrefix}::`))) {
          throw new Error("Malformed IndexedDB snapshot database names");
        }
        names.add(name);
      }
      // Replay the whole candidate before replacing retained account databases:
      // structural JSON validation cannot prove key, schema, or index constraints.
      await restoreIndexedDatabases(snapshot, new IDBFactory());
      await clearAccountIndexedDatabases(databasePrefix);
      await restoreIndexedDatabases(snapshot, fakeIndexedDB);
      LogService.info(
        "IdbPersistence",
        `Restored ${snapshot.length} IndexedDB database(s) from Matrix SQLite state`,
      );
      return true;
    });
  } catch (err) {
    if (err instanceof MatrixIdbSnapshotMigrationRequiredError) {
      throw err;
    }
    if (!callbackStarted && fs.existsSync(resolvedPath)) {
      throwLegacySnapshotMigrationRequired();
    }
    LogService.warn("IdbPersistence", "Failed to restore IndexedDB snapshot from SQLite:", err);
    throw err;
  }
}

export async function persistIdbToDisk(params?: {
  // Production callers pass MatrixStoragePaths.idbSnapshotPath; explicit paths only isolate tests.
  snapshotPath?: string;
  databasePrefix?: string;
  strict?: boolean;
  abortSignal?: AbortSignal;
  stateRuntime?: MatrixSnapshotStateRuntime;
}): Promise<void> {
  const snapshotPath = params?.snapshotPath ?? resolveDefaultIdbSnapshotPath();
  let callbackStarted = false;
  try {
    const stateRuntime = params?.stateRuntime ?? getMatrixRuntime().state;
    fs.mkdirSync(path.dirname(snapshotPath), { recursive: true });
    // withFileLock is acquire-or-throw; it never skips the callback on contention.
    const persistedCount = await withFileLock(
      snapshotPath,
      MATRIX_IDB_SNAPSHOT_LOCK_OPTIONS,
      async () => {
        callbackStarted = true;
        const storageRootDir = path.dirname(snapshotPath);
        await readCanonicalSnapshot(snapshotPath, stateRuntime);
        const snapshot = await dumpIndexedDatabases(params?.databasePrefix);
        if (params?.abortSignal?.aborted || snapshot.length === 0) {
          return 0;
        }
        // Once publication begins, finish every row and cleanup before releasing the lock.
        await writeMatrixIdbSnapshotJson({
          storageRootDir,
          snapshotJson: JSON.stringify(snapshot),
          databaseCount: snapshot.length,
          stateRuntime,
        });
        return snapshot.length;
      },
    );
    if (persistedCount === 0) {
      return;
    }
    LogService.debug(
      "IdbPersistence",
      `Persisted ${persistedCount} IndexedDB database(s) to Matrix SQLite state`,
    );
  } catch (err) {
    if (err instanceof MatrixIdbSnapshotMigrationRequiredError) {
      throw err;
    }
    if (!callbackStarted && fs.existsSync(snapshotPath)) {
      throwLegacySnapshotMigrationRequired();
    }
    LogService.warn("IdbPersistence", "Failed to persist IndexedDB snapshot:", err);
    if (params?.strict) {
      throw err;
    }
  }
}

function throwIfLegacySnapshotNeedsDoctor(snapshotPath: string): void {
  if (fs.existsSync(snapshotPath)) {
    throwLegacySnapshotMigrationRequired();
  }
}

function throwLegacySnapshotMigrationRequired(): never {
  LogService.warn("IdbPersistence", LEGACY_SNAPSHOT_DIAGNOSTIC);
  throw new MatrixIdbSnapshotMigrationRequiredError();
}
