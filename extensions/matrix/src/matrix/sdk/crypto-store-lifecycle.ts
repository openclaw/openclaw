import type { SqliteBackedMatrixSyncStore } from "../client/file-sync-store.js";
import type { MatrixCryptoStoreOwnership } from "./crypto-store-ownership.js";

/** A shared SDK generation can have more than one monitor lease. */
export function createMatrixCryptoYieldHandlers(
  getOwnership: () => MatrixCryptoStoreOwnership | null,
) {
  const handlers = new Set<() => void>();
  const notify = () => {
    for (const handler of handlers) {
      handler();
    }
  };
  return {
    currentCallback: () => (handlers.size > 0 ? notify : undefined),
    add: (handler: () => void) => {
      handlers.add(handler);
      getOwnership()?.setYieldHandler(notify);
      return () => {
        handlers.delete(handler);
        if (handlers.size === 0) {
          getOwnership()?.setYieldHandler(undefined);
        }
      };
    },
  };
}

export async function closeMatrixCryptoStores(
  closeRecoveryKeys: () => Promise<void>,
  releaseOwnership: () => Promise<void>,
): Promise<void> {
  // Recovery-key writes belong to the owner session. Release only after close settles.
  const recovery = await Promise.allSettled([closeRecoveryKeys()]);
  const release = await Promise.allSettled([releaseOwnership()]);
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
  params.syncStore?.markCleanShutdown();
  await params.syncStore?.flush();
  if (params.cryptoInitialized) {
    await params.ownership?.clearUnsafeState();
  }
}

/** Join an in-flight crypto initialization before a generation can be retired. */
export function createMatrixCryptoInitializationGate() {
  let pending: Promise<void> | null = null;
  return {
    get pending(): Promise<void> | null {
      return pending;
    },
    async run(initialize: () => Promise<void>, abortSignal?: AbortSignal): Promise<void> {
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
