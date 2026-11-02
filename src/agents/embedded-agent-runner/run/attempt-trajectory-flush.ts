import { runAgentCleanupStep } from "../../run-cleanup-timeout.js";

export async function flushEmbeddedAttemptTrajectoryRecorder(params: {
  runId: string;
  sessionId: string;
  trajectoryRecorder: {
    describeFlushState: () => string | undefined;
    flush: () => Promise<void>;
  } | null;
  log: { warn: (message: string) => void };
}): Promise<void> {
  await runAgentCleanupStep({
    ...params,
    step: "openclaw-trajectory-flush",
    getTimeoutDetails: () => params.trajectoryRecorder?.describeFlushState(),
    cleanup: async () => {
      await params.trajectoryRecorder?.flush();
    },
  });
}
