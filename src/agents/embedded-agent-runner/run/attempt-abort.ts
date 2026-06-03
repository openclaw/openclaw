import type { EmbeddedAttemptSessionLockController } from "./attempt.session-lock.js";

type AbortLockReleaseLog = {
  warn(message: string): void;
};

/**
 * Starts abort-time retained-lock release without blocking the abort path;
 * failures are logged because abort/timeout handling must keep unwinding.
 */
export function releaseEmbeddedAttemptSessionLockForAbort(params: {
  sessionLockController: Pick<EmbeddedAttemptSessionLockController, "releaseHeldLockForAbort">;
  log: AbortLockReleaseLog;
  runId: string;
  abortKind: "abort" | "timeout abort";
}): void {
  void params.sessionLockController.releaseHeldLockForAbort().catch((err: unknown) => {
    params.log.warn(
      `failed to release session lock on ${params.abortKind}: runId=${params.runId} ${String(err)}`,
    );
  });
}
