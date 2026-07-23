// Matrix plugin module owns the doctor-only crypto snapshot import.
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { withFileLock } from "openclaw/plugin-sdk/file-lock";
import type { PluginDoctorStateMigrationContext } from "openclaw/plugin-sdk/runtime-doctor";
import {
  MATRIX_IDB_SNAPSHOT_FILENAME,
  openMatrixIdbSnapshotStoreOptions,
  readMatrixIdbSnapshotJsonFromStore,
  writeMatrixIdbSnapshotJsonToStore,
  type MatrixIdbSnapshotRecord,
} from "./crypto-state-store.js";
import { MATRIX_IDB_SNAPSHOT_LOCK_OPTIONS } from "./sdk/idb-persistence-lock.js";
import {
  isValidMatrixIdbSnapshotJson,
  readLegacyMatrixIdbSnapshotStateUnlocked,
} from "./sdk/idb-persistence.js";

export async function migrateLegacyMatrixIdbSnapshot(params: {
  storageRootDir: string;
  context: PluginDoctorStateMigrationContext;
  changes: string[];
  notices: string[];
  warnings: string[];
}): Promise<void> {
  const snapshotPath = path.join(params.storageRootDir, MATRIX_IDB_SNAPSHOT_FILENAME);
  try {
    // withFileLock is acquire-or-throw; it never skips the callback on contention.
    await withFileLock(snapshotPath, MATRIX_IDB_SNAPSHOT_LOCK_OPTIONS, async () => {
      await migrateLegacyMatrixIdbSnapshotLocked(params);
    });
  } catch (err) {
    params.warnings.push(
      `Failed locking Matrix IndexedDB snapshot for ${params.storageRootDir}: ${String(err)}; left legacy source in place`,
    );
  }
}

async function migrateLegacyMatrixIdbSnapshotLocked(params: {
  storageRootDir: string;
  context: PluginDoctorStateMigrationContext;
  changes: string[];
  notices: string[];
  warnings: string[];
}): Promise<void> {
  const snapshot = readLegacyMatrixIdbSnapshotStateUnlocked(params.storageRootDir);
  if (!snapshot) {
    params.warnings.push(
      `Matrix IndexedDB snapshot legacy source is invalid for ${params.storageRootDir}; archived without import`,
    );
    await archiveLegacyMatrixIdbSnapshot(params);
    return;
  }
  const snapshotJson = JSON.stringify(snapshot);
  const store = params.context.openPluginStateKeyedStore<MatrixIdbSnapshotRecord>(
    openMatrixIdbSnapshotStoreOptions(params.storageRootDir),
  );
  let persisted: string | null;
  let hadPartialState: boolean;
  try {
    persisted = await readMatrixIdbSnapshotJsonFromStore({ store });
    const persistedIsValid = persisted ? isValidMatrixIdbSnapshotJson(persisted) : false;
    hadPartialState = !persistedIsValid && (await store.entries()).length > 0;
    if (!persistedIsValid) {
      persisted = null;
    }
  } catch (err) {
    params.warnings.push(
      `Failed inspecting Matrix IndexedDB snapshot SQLite state for ${params.storageRootDir}: ${String(err)}; left legacy source in place`,
    );
    return;
  }
  if (persisted && !snapshotContentMatches(persisted, snapshot)) {
    params.notices.push(
      `Kept the canonical Matrix IndexedDB snapshot in SQLite and archived a differing legacy source for ${params.storageRootDir}`,
    );
    await archiveLegacyMatrixIdbSnapshot(params);
    return;
  }
  if (!persisted) {
    try {
      await writeMatrixIdbSnapshotJsonToStore({
        snapshotJson,
        databaseCount: snapshot.length,
        store,
      });
      persisted = await readMatrixIdbSnapshotJsonFromStore({ store });
    } catch (err) {
      params.warnings.push(
        `Failed importing Matrix IndexedDB snapshot for ${params.storageRootDir}: ${String(err)}; left legacy source in place`,
      );
      return;
    }
    if (!persisted || !snapshotContentMatches(persisted, snapshot)) {
      params.warnings.push(
        `Failed verifying Matrix IndexedDB snapshot for ${params.storageRootDir}; left legacy source in place`,
      );
      return;
    }
    params.changes.push(
      hadPartialState
        ? `Repaired partial or invalid Matrix IndexedDB snapshot SQLite state for ${params.storageRootDir}`
        : `Migrated Matrix IndexedDB snapshot JSON to SQLite for ${params.storageRootDir}`,
    );
  }
  await archiveLegacyMatrixIdbSnapshot(params);
}

function snapshotContentMatches(persistedJson: string, snapshot: unknown): boolean {
  try {
    return isDeepStrictEqual(JSON.parse(persistedJson), snapshot);
  } catch {
    return false;
  }
}

async function archiveLegacyMatrixIdbSnapshot(params: {
  storageRootDir: string;
  changes: string[];
  warnings: string[];
}): Promise<void> {
  const sourcePath = path.join(params.storageRootDir, MATRIX_IDB_SNAPSHOT_FILENAME);
  const timestamp = new Date().toISOString().replaceAll(":", "-");
  const archivePath = `${sourcePath}.migrated-${timestamp}-${randomUUID()}`;
  try {
    await fs.rename(sourcePath, archivePath);
    params.changes.push(`Archived Matrix IndexedDB snapshot legacy source -> ${archivePath}`);
  } catch (err) {
    params.warnings.push(
      `Failed archiving Matrix IndexedDB snapshot legacy source: ${String(err)}`,
    );
  }
}
