/**
 * Fence and read-checkpoint primitives shared between the deferred turn
 * maintenance scheduler, its worker, and the runtime-context transcript
 * rewrite helper.
 */
import type { TranscriptRewriteResult } from "../../context-engine/types.js";

/**
 * Per-run safety fence shared between the queue timeout hook and the running
 * worker. Once a deferred run times out the lane is released and a queued user
 * turn can proceed, so a worker still unwinding must not perform late side
 * effects (transcript rewrite, task complete/fail, progress) against state the
 * foreground turn has already read.
 */
export type DeferredTurnMaintenanceFence = { tripped: boolean };

/**
 * Bounded read checkpoint that complements the write-side fence. The lane (and
 * therefore the read barrier the next same-session turn awaits) is released at
 * the timeout point for liveness, while a transcript persist admitted just
 * before the timeout may still be awaiting I/O in the background worker. This
 * tracker lets the timeout path wait for that single in-flight persist to
 * settle so the next same-session read never observes a half-applied rewrite.
 * It is bounded to one persist: once the fence trips the rewrite helper no-ops
 * every fresh request, so no new persist can start after a timeout.
 */
export type DeferredTurnMaintenancePersistenceCheckpoint = {
  /** Record the promise for a persist attempt as it begins. */
  track: (persist: Promise<unknown>) => void;
  /** Resolve once the currently in-flight persist settles, or immediately when none is. */
  waitForInFlight: () => Promise<void>;
};

export function createDeferredTurnMaintenancePersistenceCheckpoint(): DeferredTurnMaintenancePersistenceCheckpoint {
  let inFlight: Promise<unknown> | undefined;
  return {
    track: (persist) => {
      inFlight = persist;
      // Clear once settled so a later waitForInFlight never blocks on a persist
      // that already finished (and never rethrows its failure into the barrier).
      const clear = () => {
        if (inFlight === persist) {
          inFlight = undefined;
        }
      };
      persist.then(clear, clear);
    },
    waitForInFlight: async () => {
      const current = inFlight;
      if (!current) {
        return;
      }
      await current.catch(() => {});
    },
  };
}

export function fencedTranscriptRewriteResult(): TranscriptRewriteResult {
  return {
    changed: false,
    bytesFreed: 0,
    rewrittenEntries: 0,
    reason: "maintenance fenced after timeout",
  };
}
