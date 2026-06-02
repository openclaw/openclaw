import type { EmbeddedAttemptSessionLockController } from "./attempt.session-lock.js";

type AbortLockReleaseLog = {
  warn(message: string): void;
};

/** Releases the retained session lock in the background when a run aborts. */
export function releaseEmbeddedAttemptSessionLockForAbort(params: {
  sessionLockController: Pick<EmbeddedAttemptSessionLockController, "releaseHeldLockForAbort">;
  log: AbortLockReleaseLog;
  runId: string;
  abortKind: "abort" | "timeout abort";
}): void {
  // The abort path cannot await cleanup without delaying cancellation. Log
  // failures instead of rethrowing into caller-owned abort handlers.
  void params.sessionLockController.releaseHeldLockForAbort().catch((err: unknown) => {
    params.log.warn(
      `failed to release session lock on ${params.abortKind}: runId=${params.runId} ${String(err)}`,
    );
  });
}
