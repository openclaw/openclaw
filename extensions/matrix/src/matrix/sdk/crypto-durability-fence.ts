import { noop } from "./logger.js";

export type MatrixCryptoDurabilityFence = {
  /** Takes the snapshot, or rejects when the generation is no longer active. */
  persist: () => Promise<void>;
  /** Resolves once no snapshot started through this fence is still running. */
  settled: () => Promise<void>;
};

/**
 * Strict crypto snapshots on behalf of an in-flight request or sync cursor.
 * An Olm message must not leave the process, and a cursor must not move past
 * to-device events, before the crypto state behind them is durable. A stopped
 * generation must not start one: the caller is about to be rejected, and a
 * successor generation may already own the stored state. A snapshot that was
 * already publishing when the generation stopped still finishes its write, so
 * the generation's retirement waits on `settled` to stay ordered behind it.
 */
export function createMatrixCryptoDurabilityFence(params: {
  assertActive: () => void;
  /** Strict snapshot; skips publication when the generation aborts during the dump. */
  snapshot: () => Promise<void>;
}): MatrixCryptoDurabilityFence {
  const running = new Set<Promise<void>>();
  const run = async () => {
    params.assertActive();
    await params.snapshot();
    // An abort during the dump skips publication without failing the snapshot.
    params.assertActive();
  };
  return {
    persist: () => {
      const snapshot = run();
      running.add(snapshot);
      void snapshot.catch(noop).finally(() => running.delete(snapshot));
      return snapshot;
    },
    settled: async () => {
      await Promise.allSettled(running);
    },
  };
}
