import { getAsyncWorkSignal } from "../../shared/async-work-scope.js";
import type { EmbeddedRunAttemptParams } from "../embedded-agent-runner/run/types.js";
import type { AgentHarnessHostCapabilities } from "./host-capability-types.js";

export function bindHarnessTrajectory(
  attempt: Pick<EmbeddedRunAttemptParams, "trajectoryRecorder" | "abortSignal">,
  assertActive: () => void,
  assertScopeCurrent: () => void,
): Pick<AgentHarnessHostCapabilities, "trajectory"> {
  const recorder = attempt.trajectoryRecorder;
  if (!recorder) {
    return {};
  }
  const workSignal = getAsyncWorkSignal();
  const attemptSignal = attempt.abortSignal;
  const assertCleanupActive = () => {
    assertScopeCurrent();
    if (attempt.trajectoryRecorder !== recorder) {
      throw new Error("agent harness trajectory cleanup is no longer active");
    }
  };
  return {
    trajectory: Object.freeze({
      recordEvent: (type: string, data?: Record<string, unknown>) => {
        workSignal?.throwIfAborted();
        attemptSignal?.throwIfAborted();
        assertActive();
        assertCleanupActive();
        recorder.recordEvent(type, data);
      },
      flush: async () => {
        assertCleanupActive();
        await recorder.flush();
        assertCleanupActive();
      },
    }),
  };
}
