import { runAgentCleanupStep } from "../../run-cleanup-timeout.js";

/** Minimal recorder surface needed during embedded-attempt cleanup. */
export type EmbeddedAttemptTrajectoryRecorder = {
  describeFlushState: () => string | undefined;
  flush: () => Promise<void>;
};

/** Flushes trajectory records without letting a stalled flush block cleanup forever. */
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
