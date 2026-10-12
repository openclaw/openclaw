import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { syncDirectory } from "@openclaw/fs-safe/durability";
import {
  acquireFileLock,
  FILE_LOCK_STALE_ERROR_CODE,
  FILE_LOCK_TIMEOUT_ERROR_CODE,
  type FileLockHandle,
  type FileLockOptions,
} from "openclaw/plugin-sdk/file-lock";
import { getMatrixRuntime } from "../../runtime.js";
import {
  readMatrixIdbSnapshotOwnerGeneration,
  sealMatrixIdbSnapshotOwnerGeneration,
  type MatrixSnapshotStateRuntime,
} from "../crypto-state-store.js";

const MATRIX_CRYPTO_STORE_OWNER_ACTIVE_ERROR_CODE = "matrix_crypto_store_owner_active";
const RETRY_MS = 200;
const WAIT_TIMEOUT_MS = 120_000;
const GUARD_BYTES = 33;

class MatrixCryptoStoreOwnerActiveError extends Error {
  readonly code = MATRIX_CRYPTO_STORE_OWNER_ACTIVE_ERROR_CODE;

  constructor(cause: unknown) {
    super("Timed out waiting for exclusive Matrix crypto state ownership", { cause });
    this.name = "MatrixCryptoStoreOwnerActiveError";
  }
}

export type MatrixCryptoStoreOwnership = Pick<FileLockHandle, "release"> & {
  armUnsafeState: () => Promise<void>;
  cancelUnsafeState: () => Promise<void>;
  sealSafeState: () => Promise<void>;
};

const LOCK_OPTIONS: FileLockOptions = {
  retries: { retries: 0, factor: 1, minTimeout: 0, maxTimeout: 0 },
  stale: 0,
  staleRecovery: "remove-if-definitely-stale",
};

function isContention(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error.code === FILE_LOCK_TIMEOUT_ERROR_CODE || error.code === FILE_LOCK_STALE_ERROR_CODE)
  );
}

function filesystemErrorCode(error: unknown): unknown {
  return error !== null && typeof error === "object" && "code" in error ? error.code : undefined;
}

function poisonPath(snapshotPath: string): string {
  return `${snapshotPath}.owner.poisoned`;
}

/** Doctor-only lock: inspect and recover refusal state without entering crypto. */
export async function withMatrixCryptoStoreRecoveryLock<T>(
  snapshotPath: string,
  inspect: (markerPath: string) => Promise<T>,
): Promise<T> {
  const lock = await acquireFileLock(`${snapshotPath}.owner`, LOCK_OPTIONS);
  try {
    return await inspect(poisonPath(snapshotPath));
  } finally {
    await lock.release();
  }
}

async function syncParentDirectory(filePath: string): Promise<void> {
  try {
    await syncDirectory(path.dirname(filePath));
  } catch (error) {
    const code = filesystemErrorCode(error);
    if (
      process.platform !== "win32" ||
      !["EINVAL", "ENOTSUP", "ENOSYS", "EISDIR", "EPERM", "EACCES"].includes(String(code))
    ) {
      throw error;
    }
  }
}

/** Null is a legacy/fresh store without a guard; empty means an invalid or old refusal marker. */
async function readOwnerGuard(snapshotPath: string): Promise<string | null> {
  const marker = poisonPath(snapshotPath);
  let stat;
  try {
    stat = await fs.lstat(marker);
  } catch (error) {
    if (filesystemErrorCode(error) === "ENOENT") {
      return null;
    }
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error("Matrix crypto owner guard must be a regular file");
  }
  if (stat.size !== GUARD_BYTES) {
    return "";
  }
  const file = await fs.open(marker, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const bytes = Buffer.alloc(GUARD_BYTES);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    const value = bytes.toString("utf8");
    return bytesRead === GUARD_BYTES && /^[a-f0-9]{32}\n$/.test(value) ? value.trimEnd() : "";
  } finally {
    await file.close();
  }
}

/** Flush the guard before Rust mutates state; retain its inode across clean generations. */
async function writeOwnerGuard(
  snapshotPath: string,
  generation: string,
  create: boolean,
  onChanged: () => void = () => {},
): Promise<void> {
  const marker = poisonPath(snapshotPath);
  const flags =
    constants.O_RDWR |
    (constants.O_NOFOLLOW ?? 0) |
    (create ? constants.O_CREAT | constants.O_EXCL : 0);
  const file = await fs.open(marker, flags, 0o600);
  try {
    if (!(await file.stat()).isFile()) {
      throw new Error("Matrix crypto owner guard must be a regular file");
    }
    onChanged();
    await file.writeFile(`${generation}\n`, "ascii");
    await file.truncate(GUARD_BYTES);
    await file.sync();
  } finally {
    await file.close();
  }
  if (create) {
    await syncParentDirectory(marker);
  }
}

/** The caller holds custody. Snapshot checksum and schema validation remain the restore owner's job. */
export async function isMatrixCryptoStoreUnsafe(
  snapshotPath: string,
  stateRuntime: MatrixSnapshotStateRuntime = getMatrixRuntime().state,
): Promise<boolean> {
  const guard = await readOwnerGuard(snapshotPath);
  if (guard === "") {
    return true;
  }
  const cleanGeneration = await readMatrixIdbSnapshotOwnerGeneration(
    path.dirname(snapshotPath),
    stateRuntime,
  );
  return guard === null ? cleanGeneration !== undefined : guard !== cleanGeneration;
}

/** Doctor has already validated the snapshot and obtained explicit rollback consent under custody. */
export async function sealMatrixCryptoStoreRecovery(
  snapshotPath: string,
  stateRuntime: MatrixSnapshotStateRuntime = getMatrixRuntime().state,
): Promise<void> {
  const guard = await readOwnerGuard(snapshotPath);
  const generation = randomUUID().replaceAll("-", "");
  await writeOwnerGuard(snapshotPath, generation, guard === null);
  await sealMatrixIdbSnapshotOwnerGeneration(path.dirname(snapshotPath), generation, stateRuntime);
}

async function waitRetry(signal?: AbortSignal): Promise<void> {
  const abortError = () => {
    if (signal?.reason instanceof Error) {
      return signal.reason;
    }
    const error = new Error("Matrix crypto ownership wait aborted", { cause: signal?.reason });
    error.name = "AbortError";
    return error;
  };
  await new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, RETRY_MS);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function acquireMatrixCryptoStoreOwnership(
  snapshotPath: string,
  options: { signal?: AbortSignal; stateRuntime?: MatrixSnapshotStateRuntime } = {},
): Promise<MatrixCryptoStoreOwnership> {
  const stateRuntime = options.stateRuntime ?? getMatrixRuntime().state;
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  let lock: FileLockHandle;
  while (true) {
    options.signal?.throwIfAborted();
    try {
      lock = await acquireFileLock(`${snapshotPath}.owner`, LOCK_OPTIONS);
      break;
    } catch (error) {
      if (!isContention(error)) {
        throw error;
      }
      if (Date.now() >= deadline) {
        throw new MatrixCryptoStoreOwnerActiveError(error);
      }
      await waitRetry(options.signal);
    }
  }
  let previousGuard: string | null;
  try {
    options.signal?.throwIfAborted();
    // Inspect only under custody: a live owner intentionally keeps its guard ahead of the seal.
    if (await isMatrixCryptoStoreUnsafe(snapshotPath, stateRuntime)) {
      throw new Error(
        "Matrix crypto state has an unresolved unsafe final state (discarded, failed, or lost save); refusing another owner",
      );
    }
    previousGuard = await readOwnerGuard(snapshotPath);
  } catch (error) {
    await lock.release();
    throw error;
  }

  const generation = randomUUID().replaceAll("-", "");
  let guardChanged = false;
  let sealed = false;
  let armPromise: Promise<void> | undefined;
  let pending = Promise.resolve();
  let releasePromise: Promise<void> | undefined;
  const underCustody = (run: () => Promise<void>): Promise<void> => {
    if (releasePromise) {
      return Promise.reject(new Error("Matrix crypto ownership has been released"));
    }
    const task = pending.then(run);
    pending = task.catch(() => {});
    return task;
  };
  return {
    armUnsafeState: () =>
      underCustody(async () => {
        if (sealed) {
          throw new Error("Matrix crypto generation has already been sealed");
        }
        armPromise ??= writeOwnerGuard(snapshotPath, generation, previousGuard === null, () => {
          // Cancellation must undo even a write whose durability operation failed.
          guardChanged = true;
        });
        await armPromise;
      }),
    cancelUnsafeState: () =>
      underCustody(async () => {
        // Only initialization that never entered Rust may restore the previously admitted guard.
        if (!guardChanged) {
          return;
        }
        if (previousGuard === null) {
          await fs.unlink(poisonPath(snapshotPath));
          await syncParentDirectory(poisonPath(snapshotPath));
        } else {
          await writeOwnerGuard(snapshotPath, previousGuard, false);
        }
        guardChanged = false;
        armPromise = undefined;
      }),
    sealSafeState: () =>
      underCustody(async () => {
        if (!guardChanged) {
          return;
        }
        await armPromise;
        try {
          await sealMatrixIdbSnapshotOwnerGeneration(
            path.dirname(snapshotPath),
            generation,
            stateRuntime,
          );
        } catch (error) {
          // A lost write acknowledgment can be reconciled without surrendering custody.
          const committed = await readMatrixIdbSnapshotOwnerGeneration(
            path.dirname(snapshotPath),
            stateRuntime,
          ).catch(() => undefined);
          if (committed !== generation) {
            throw error;
          }
        }
        guardChanged = false;
        sealed = true;
      }),
    release: () => {
      releasePromise ??= pending.then(() => lock.release());
      return releasePromise;
    },
  };
}
