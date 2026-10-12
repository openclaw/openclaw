import type { SqliteBackedMatrixSyncStore } from "../client/file-sync-store.js";
import type { MatrixCryptoStoreOwnership } from "./crypto-store-ownership.js";

export async function closeMatrixCryptoStores(
  closeRecoveryKeys: () => Promise<void>,
  releaseOwnership: () => Promise<void>,
  teardownComplete: boolean,
): Promise<void> {
  // Recovery-key writes belong to the owner session. Release only after close settles.
  const recovery = await Promise.allSettled([closeRecoveryKeys()]);
  // Recovery must never acquire a store whose backend teardown is uncertain.
  const release = teardownComplete ? await Promise.allSettled([releaseOwnership()]) : [];
  const failures = [...recovery, ...release]
    .filter((result) => result.status === "rejected")
    .map((result) => result.reason);
  if (failures.length > 1) {
    throw new AggregateError(failures, "Failed to close Matrix crypto stores");
  }
  if (failures.length === 1) {
    throw failures[0];
  }
}

/** Final publication is allowed only for a generation that initialized under custody. */
export async function persistMatrixFinalState(params: {
  encryptionEnabled: boolean;
  cryptoInitialized: boolean;
  ownership: MatrixCryptoStoreOwnership | null;
  snapshotPath?: string;
  persistSnapshot: () => Promise<void>;
  syncStore?: SqliteBackedMatrixSyncStore;
}): Promise<void> {
  if (params.cryptoInitialized) {
    if (params.snapshotPath && !params.ownership) {
      throw new Error("Refusing Matrix crypto snapshot publication without ownership");
    }
    await params.persistSnapshot();
  }
  // An uninitialized encrypted diagnostic cannot certify a cursor against
  // crypto state it never owned or exported. Preserve its loaded clean flag.
  if (!params.encryptionEnabled || params.cryptoInitialized) {
    params.syncStore?.markCleanShutdown();
  }
  await params.syncStore?.flush();
  if (params.cryptoInitialized) {
    await params.ownership?.sealSafeState();
  }
}

/** Join an in-flight crypto initialization before a generation can be retired. */
export function createMatrixCryptoInitializationGate() {
  let pending: Promise<void> | null = null;
  let failure: { error: unknown } | null = null;
  return {
    get pending(): Promise<void> | null {
      return pending;
    },
    get failure(): { error: unknown } | null {
      return failure;
    },
    recordFailure(error: unknown): void {
      failure = { error };
    },
    async run(initialize: () => Promise<void>, abortSignal?: AbortSignal): Promise<void> {
      if (failure) {
        throw new Error(
          "Matrix crypto initialization failed; restart this process before retrying",
          {
            cause: failure.error,
          },
        );
      }
      if (pending) {
        await pending;
        abortSignal?.throwIfAborted();
        return;
      }
      const task = initialize();
      pending = task;
      try {
        await task;
      } finally {
        if (pending === task) {
          pending = null;
        }
      }
    },
  };
}

/** Quiescence failure forbids publication but still requires teardown under custody. */
export async function runMatrixClientShutdown(params: {
  persist: boolean;
  quiesceSync: () => Promise<void>;
  discardSync: () => void;
  stop: (persist: boolean) => Promise<void>;
  closeStores: () => Promise<void>;
}): Promise<void> {
  const failures: unknown[] = [];
  let persist = params.persist;
  try {
    try {
      await params.quiesceSync();
    } catch (error) {
      if (persist) {
        failures.push(error);
      }
      persist = false;
    }
    if (!persist) {
      params.discardSync();
    }
    await params.stop(persist);
  } catch (error) {
    failures.push(error);
    params.discardSync();
  } finally {
    try {
      await params.closeStores();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length === 1) {
    throw failures[0];
  }
  if (failures.length > 1) {
    throw new AggregateError(failures, "Failed to shut down Matrix client generation");
  }
}

/** SDK crypto stop is not retryable after throwing: it marks itself stopped before store closure. */
export function createMatrixSdkStopGate() {
  let stopped = false;
  let failure: { error: unknown } | null = null;
  return {
    get stopped(): boolean {
      return stopped || failure !== null;
    },
    stop(stopSdk: () => void): void {
      if (stopped) {
        return;
      }
      if (failure) {
        throw failure.error;
      }
      try {
        stopSdk();
        stopped = true;
      } catch (error) {
        // A later SDK stop may silently skip unfinished closure. Keep custody until process exit.
        failure = { error };
        throw error;
      }
    },
  };
}
