import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resetFileLockStateForTest } from "openclaw/plugin-sdk/file-lock";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installMatrixTestRuntime } from "../test-runtime.js";
import { MATRIX_IDB_SNAPSHOT_FILENAME, writeMatrixIdbSnapshotJson } from "./crypto-state-store.js";
import {
  listMatrixCryptoUnsafeState,
  recoverMatrixCryptoUnsafeState,
} from "./crypto-unsafe-state-doctor.js";
import { acquireMatrixCryptoStoreOwnership } from "./sdk/crypto-store-ownership.js";

let stateDir: string;
let storageRootDir: string;
let snapshotPath: string;
let markerPath: string;

beforeEach(async () => {
  stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "matrix-unsafe-doctor-"));
  storageRootDir = path.join(
    stateDir,
    "matrix",
    "accounts",
    "default",
    "example.org__bot",
    "0123456789abcdef",
  );
  await fs.mkdir(storageRootDir, { recursive: true });
  snapshotPath = path.join(storageRootDir, MATRIX_IDB_SNAPSHOT_FILENAME);
  markerPath = `${snapshotPath}.owner.poisoned`;
  installMatrixTestRuntime({ stateDir });
});

afterEach(async () => {
  await closeOpenClawStateDatabaseAsync();
  resetPluginStateStoreForTests();
  resetFileLockStateForTest();
  await fs.rm(stateDir, { recursive: true, force: true });
});

describe("Matrix crypto unsafe-state Doctor", () => {
  it("inspects refusal without clearing it and requires explicit rollback acceptance", async () => {
    await fs.writeFile(markerPath, "unsafe\n");
    expect(await listMatrixCryptoUnsafeState(stateDir)).toEqual([storageRootDir]);
    await expect(
      recoverMatrixCryptoUnsafeState({ storageRootDir, acceptSnapshotRollback: false }),
    ).rejects.toThrow("explicit");
    await expect(
      recoverMatrixCryptoUnsafeState({ storageRootDir, acceptSnapshotRollback: true }),
    ).rejects.toThrow("absent");
    expect(await listMatrixCryptoUnsafeState(stateDir)).toEqual([storageRootDir]);
  });

  it("does not report an armed marker while its crypto owner is live", async () => {
    const owner = await acquireMatrixCryptoStoreOwnership(snapshotPath);
    try {
      await owner.armUnsafeState();
      expect(await listMatrixCryptoUnsafeState(stateDir)).toEqual([]);
    } finally {
      await owner.release();
    }
    expect(await listMatrixCryptoUnsafeState(stateDir)).toEqual([storageRootDir]);
  });

  it("refuses recovery while a live owner holds the crypto store", async () => {
    await fs.writeFile(markerPath, "unsafe\n");
    const owner = await acquireMatrixCryptoStoreOwnership(snapshotPath).catch(() => null);
    // The normal owner correctly refuses an existing marker; use the Doctor lock itself.
    expect(owner).toBeNull();
    await writeMatrixIdbSnapshotJson({
      storageRootDir,
      snapshotJson: JSON.stringify([{ name: "crypto", version: 1, stores: [] }]),
      databaseCount: 1,
    });
    const { withMatrixCryptoStoreRecoveryLock } = await import("./sdk/crypto-store-ownership.js");
    await withMatrixCryptoStoreRecoveryLock(snapshotPath, async () => {
      await expect(
        recoverMatrixCryptoUnsafeState({ storageRootDir, acceptSnapshotRollback: true }),
      ).rejects.toThrow();
      expect(await listMatrixCryptoUnsafeState(stateDir)).toEqual([]);
    });
  });

  it("clears refusal only after validating the canonical SQLite snapshot", async () => {
    await fs.writeFile(markerPath, "unsafe\n");
    await writeMatrixIdbSnapshotJson({
      storageRootDir,
      snapshotJson: JSON.stringify([{ name: "crypto", version: 1, stores: [] }]),
      databaseCount: 1,
    });
    await recoverMatrixCryptoUnsafeState({ storageRootDir, acceptSnapshotRollback: true });
    expect(await listMatrixCryptoUnsafeState(stateDir)).toEqual([]);
    const owner = await acquireMatrixCryptoStoreOwnership(snapshotPath);
    await owner.release();
  });
});
