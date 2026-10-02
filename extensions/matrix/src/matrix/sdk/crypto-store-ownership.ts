import { randomUUID } from "node:crypto";
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
import { getFileLockProcessStartTime, isPidAlive } from "openclaw/plugin-sdk/process-runtime";

const MATRIX_CRYPTO_STORE_OWNER_ACTIVE_ERROR_CODE = "matrix_crypto_store_owner_active";
const RETRY_MS = 200;
const WAIT_TIMEOUT_MS = 120_000;

class MatrixCryptoStoreOwnerActiveError extends Error {
  readonly code = MATRIX_CRYPTO_STORE_OWNER_ACTIVE_ERROR_CODE;

  constructor(cause: unknown) {
    super("Timed out waiting for exclusive Matrix crypto state ownership", { cause });
    this.name = "MatrixCryptoStoreOwnerActiveError";
  }
}

export type MatrixCryptoStoreOwnership = Pick<FileLockHandle, "release"> & {
  setYieldHandler: (handler: (() => void) | undefined) => void;
  armUnsafeState: () => Promise<void>;
  clearUnsafeState: () => Promise<void>;
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

/** Arm before Rust crypto can mutate state; failure to arm means no crypto work. */
async function poisonMatrixCryptoStore(snapshotPath: string): Promise<void> {
  const marker = poisonPath(snapshotPath);
  const file = await fs.open(marker, "wx", 0o600);
  try {
    await file.writeFile(
      "The previous Matrix crypto owner did not safely publish its final state. Inspect and repair before clearing this marker.\n",
    );
    await file.sync();
  } finally {
    await file.close();
  }
  await syncParentDirectory(marker);
}

export async function clearMatrixCryptoStoreUnsafeState(snapshotPath: string): Promise<void> {
  const marker = poisonPath(snapshotPath);
  await fs.unlink(marker);
  await syncParentDirectory(marker);
}

async function assertStoreNotPoisoned(snapshotPath: string): Promise<void> {
  try {
    await fs.access(poisonPath(snapshotPath));
  } catch (error) {
    if (filesystemErrorCode(error) === "ENOENT") {
      return;
    }
    throw error;
  }
  throw new Error(
    "Matrix crypto state has an unresolved unsafe final state (discarded or failed save); refusing another owner",
  );
}

function waiterDir(snapshotPath: string): string {
  return `${snapshotPath}.owner.waiters`;
}

async function hasMatrixCryptoStoreWaiters(snapshotPath: string): Promise<boolean> {
  let entries: string[];
  try {
    entries = await fs.readdir(waiterDir(snapshotPath));
  } catch (error) {
    if (filesystemErrorCode(error) === "ENOENT") {
      return false;
    }
    throw error;
  }
  for (const entry of entries) {
    const [pidText, startText] = entry.split("-");
    const pid = Number(pidText);
    const savedStart = startText === "unknown" ? null : Number(startText);
    if (Number.isSafeInteger(pid) && pid > 0 && isPidAlive(pid)) {
      const currentStart = getFileLockProcessStartTime(pid);
      if (savedStart === null || currentStart === null || savedStart === currentStart) {
        return true;
      }
    }
    await fs.unlink(path.join(waiterDir(snapshotPath), entry)).catch(() => undefined);
  }
  return false;
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

/** The owner polls local waiter notices; no crypto command crosses the process boundary. */
export async function acquireMatrixCryptoStoreOwnership(
  snapshotPath: string,
  options: { signal?: AbortSignal; onYieldRequested?: () => void } = {},
): Promise<MatrixCryptoStoreOwnership> {
  const directory = waiterDir(snapshotPath);
  let marker: string | undefined;
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  try {
    while (true) {
      options.signal?.throwIfAborted();
      // An active owner deliberately keeps this marker armed. Only inspect it
      // after acquiring the lock; waiters must not mistake a live owner for a
      // failed prior generation.
      let lock: FileLockHandle;
      try {
        lock = await acquireFileLock(`${snapshotPath}.owner`, LOCK_OPTIONS);
      } catch (error) {
        if (!isContention(error)) {
          throw error;
        }
        if (!options.onYieldRequested && Date.now() >= deadline) {
          throw new MatrixCryptoStoreOwnerActiveError(error);
        }
        if (!options.onYieldRequested && !marker) {
          await fs.mkdir(directory, { recursive: true });
          marker = path.join(
            directory,
            `${process.pid}-${getFileLockProcessStartTime(process.pid) ?? "unknown"}-${randomUUID()}`,
          );
          await fs.writeFile(marker, "", { flag: "wx", mode: 0o600 });
        }
        await waitRetry(options.signal);
        continue;
      }
      // Recheck while holding the lock: the previous owner may have poisoned
      // the snapshot after our pre-acquisition check but before releasing it.
      let mustYield: boolean;
      try {
        await assertStoreNotPoisoned(snapshotPath);
        mustYield = Boolean(
          options.onYieldRequested && (await hasMatrixCryptoStoreWaiters(snapshotPath)),
        );
      } catch (error) {
        await lock.release();
        throw error;
      }
      if (mustYield) {
        // A returning Gateway must not recapture ownership ahead of a waiter.
        await lock.release();
        await waitRetry(options.signal);
        continue;
      }
      let timer: NodeJS.Timeout | undefined;
      let unsafeStateArmed = false;
      const setYieldHandler = (handler: (() => void) | undefined) => {
        if (timer) {
          clearInterval(timer);
          timer = undefined;
        }
        if (handler) {
          timer = setInterval(() => {
            void hasMatrixCryptoStoreWaiters(snapshotPath).then(
              (waiting) => {
                if (waiting) {
                  handler();
                }
              },
              () => undefined,
            );
          }, RETRY_MS);
          timer.unref?.();
        }
      };
      setYieldHandler(options.onYieldRequested);
      const ownedMarker = marker;
      marker = undefined;
      return {
        setYieldHandler,
        armUnsafeState: async () => {
          if (!unsafeStateArmed) {
            await poisonMatrixCryptoStore(snapshotPath);
            unsafeStateArmed = true;
          }
        },
        clearUnsafeState: async () => {
          if (unsafeStateArmed) {
            await clearMatrixCryptoStoreUnsafeState(snapshotPath);
            unsafeStateArmed = false;
          }
        },
        release: async () => {
          setYieldHandler(undefined);
          try {
            await lock.release();
          } finally {
            if (ownedMarker) {
              await fs.unlink(ownedMarker).catch(() => undefined);
            }
          }
        },
      };
    }
  } finally {
    if (marker) {
      await fs.unlink(marker).catch(() => undefined);
    }
  }
}
