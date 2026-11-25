import { getAsyncWorkSignal } from "../../shared/async-work-scope.js";
import type { EmbeddedRunAttemptParams } from "../embedded-agent-runner/run/types.js";
import type { AgentHarnessHostCapabilities } from "./host-capability-types.js";

export function bindHarnessTrajectory(
  attempt: Pick<
    EmbeddedRunAttemptParams,
    "trajectoryRecorder" | "admittedRunContext" | "abortSignal"
  >,
  assertScopeCurrent: () => void,
): Pick<AgentHarnessHostCapabilities, "trajectory"> {
  const recorder = attempt.trajectoryRecorder;
  if (!recorder) {
    return {};
  }
  const workSignal = getAsyncWorkSignal();
  const attemptSignal = attempt.abortSignal;
  const operationalRunInstance = attempt.admittedRunContext.operationalRunInstance;
  const assertCleanupActive = () => {
    assertScopeCurrent();
    if (
      attempt.admittedRunContext.operationalRunInstance !== operationalRunInstance ||
      attempt.trajectoryRecorder !== recorder
    ) {
      throw new Error("agent harness trajectory cleanup is no longer active");
    }
  };
  return {
    trajectory: Object.freeze({
      recordEvent: (type: string, data?: Record<string, unknown>) => {
        workSignal?.throwIfAborted();
        attemptSignal?.throwIfAborted();
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
