import type { FileLockOptions } from "openclaw/plugin-sdk/file-lock";

export const MATRIX_IDB_PERSIST_INTERVAL_MS = 60_000;

export const MATRIX_IDB_SNAPSHOT_LOCK_OPTIONS: FileLockOptions = {
  // 18 retries span 61,350ms before jitter, beyond the 60s persist interval.
  retries: { retries: 18, factor: 2, minTimeout: 50, maxTimeout: 5_000, randomize: true },
  // Restores and large snapshots can outlive the generic stale window. Reclaiming
  // their live lock would allow concurrent crypto-state writers.
  stale: 5 * 60_000,
};
