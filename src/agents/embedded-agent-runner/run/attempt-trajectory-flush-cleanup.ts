import { runAgentCleanupStep } from "../../run-cleanup-timeout.js";

/** Recorder contract needed by attempt cleanup without exposing recorder internals. */
export type EmbeddedAttemptTrajectoryRecorder = {
  describeFlushState: () => string | undefined;
  flush: () => Promise<void>;
};

/**
 * Flushes the trajectory recorder through the shared cleanup timeout wrapper so
 * stalled persistence reports recorder state without blocking attempt teardown.
 */
export async function flushEmbeddedAttemptTrajectoryRecorder(params: {
  runId: string;
  sessionId: string;
  trajectoryRecorder: EmbeddedAttemptTrajectoryRecorder | null;
  log: {
    warn: (message: string) => void;
  };
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}): Promise<void> {
  await runAgentCleanupStep({
    runId: params.runId,
    sessionId: params.sessionId,
    step: "openclaw-trajectory-flush",
    log: params.log,
    env: params.env,
    timeoutMs: params.timeoutMs,
    getTimeoutDetails: () => params.trajectoryRecorder?.describeFlushState(),
    cleanup: async () => {
      await params.trajectoryRecorder?.flush();
    },
  });
}
