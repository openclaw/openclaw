import { runAgentCleanupStep } from "../../run-cleanup-timeout.js";

type EmbeddedAttemptTrajectoryRecorder = {
  describeFlushState: () => string | undefined;
  flush: () => Promise<void>;
};

export async function flushEmbeddedAttemptTrajectoryRecorder(params: {
  runId: string;
  sessionId: string;
  trajectoryRecorder: EmbeddedAttemptTrajectoryRecorder | null;
  log: { warn: (message: string) => void };
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
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
