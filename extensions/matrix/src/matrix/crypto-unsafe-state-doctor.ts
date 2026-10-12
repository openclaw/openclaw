// Matrix storage-owned inspection and explicit recovery of failed crypto publication.
import fs from "node:fs/promises";
import path from "node:path";
import { FILE_LOCK_TIMEOUT_ERROR_CODE } from "openclaw/plugin-sdk/file-lock";
import { getMatrixRuntime } from "../runtime.js";
import {
  MATRIX_IDB_SNAPSHOT_FILENAME,
  readMatrixIdbSnapshotJson,
  type MatrixSnapshotStateReader,
} from "./crypto-state-store.js";
import {
  isMatrixCryptoStoreUnsafe,
  sealMatrixCryptoStoreRecovery,
  withMatrixCryptoStoreRecoveryLock,
} from "./sdk/crypto-store-ownership.js";
import { walkMatrixStateFiles } from "./state-layout-walk.js";

const MARKER_NAME = `${MATRIX_IDB_SNAPSHOT_FILENAME}.owner.poisoned`;

export async function listMatrixCryptoUnsafeState(
  stateDir: string,
  stateRuntime?: MatrixSnapshotStateReader,
): Promise<string[]> {
  const { entries, failedDirs } = await walkMatrixStateFiles(
    stateDir,
    (name, depth) =>
      ((depth === 0 || depth === 4) && name === MARKER_NAME) ||
      (depth === 5 && name === "openclaw.sqlite"),
    [0, 4],
  );
  if (failedDirs.length > 0) {
    throw failedDirs[0]!.error;
  }
  const roots = new Set(
    entries.map((entry) =>
      path.basename(entry.path) === MARKER_NAME
        ? path.dirname(entry.path)
        : path.dirname(path.dirname(entry.path)),
    ),
  );
  const abandoned: string[] = [];
  for (const root of roots) {
    const snapshotPath = path.join(root, MATRIX_IDB_SNAPSHOT_FILENAME);
    try {
      // Retained guards can be clean; missing guards can be unsafe. Inspect the
      // guard and canonical snapshot together under the exclusive recovery lock.
      const unsafe = await withMatrixCryptoStoreRecoveryLock(snapshotPath, () =>
        isMatrixCryptoStoreUnsafe(snapshotPath, stateRuntime ?? getMatrixRuntime().state),
      );
      if (unsafe) {
        abandoned.push(root);
      }
    } catch (error) {
      // Lock contention means an owner is live, not that its armed marker is abandoned.
      if (
        error !== null &&
        typeof error === "object" &&
        "code" in error &&
        error.code === FILE_LOCK_TIMEOUT_ERROR_CODE
      ) {
        continue;
      }
      throw error;
    }
  }
  return abandoned.toSorted();
}

/** A valid snapshot is a rollback point, not proof that the failed owner's last keys were saved. */
export async function recoverMatrixCryptoUnsafeState(params: {
  storageRootDir: string;
  acceptSnapshotRollback: boolean;
}): Promise<void> {
  if (!params.acceptSnapshotRollback) {
    throw new Error("Matrix crypto recovery requires explicit --accept-snapshot-rollback.");
  }
  const snapshotPath = path.join(params.storageRootDir, MATRIX_IDB_SNAPSHOT_FILENAME);
  await withMatrixCryptoStoreRecoveryLock(snapshotPath, async () => {
    try {
      await fs.access(path.join(params.storageRootDir, "state", "openclaw.sqlite"));
    } catch (error) {
      if (
        error !== null &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        throw new Error("Matrix crypto SQLite snapshot is absent; refusal remains in place.", {
          cause: error,
        });
      }
      throw error;
    }
    const snapshot = await readMatrixIdbSnapshotJson(
      params.storageRootDir,
      getMatrixRuntime().state,
    );
    if (!snapshot) {
      throw new Error(
        "Matrix crypto SQLite snapshot is absent or invalid; refusal remains in place.",
      );
    }
    const { validateMatrixIdbSnapshotJson } = await import("./sdk/idb-persistence.js");
    try {
      await validateMatrixIdbSnapshotJson(snapshot);
    } catch (error) {
      throw new Error(
        "Matrix crypto SQLite snapshot cannot be replayed; refusal remains in place.",
        {
          cause: error,
        },
      );
    }
    // Publish recovery under the owner lock after validation and explicit operator acceptance.
    // No crypto keys are read into a Matrix client during this operation.
    await sealMatrixCryptoStoreRecovery(snapshotPath, getMatrixRuntime().state);
  });
}
