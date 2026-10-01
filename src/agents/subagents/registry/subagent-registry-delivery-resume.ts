import {
  isGatewayRestartDraining,
  runWithGatewayDetachedWorkAdmission,
} from "../../../process/gateway-work-admission.js";
import { captureOpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.js";
import type {
  SubagentLifecycleController,
  SubagentLifecycleOptions,
} from "./subagent-registry-lifecycle.js";
import { assertSubagentRegistryWriteSourceCurrent } from "./subagent-registry-persistence.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

export function createSubagentDeliveryResumeScheduling({
  runs,
  resumedRuns,
  resumeRetryTimers,
  resumeSubagentRun,
  finalizeResumedAnnounceGiveUp,
  warn,
  admissionRetryDelayMs,
}: {
  runs: ReadonlyMap<string, SubagentRunRecord>;
  resumedRuns: Set<string>;
  resumeRetryTimers: Set<ReturnType<typeof setTimeout>>;
  resumeSubagentRun: (runId: string) => void;
  finalizeResumedAnnounceGiveUp: SubagentLifecycleController["finalizeResumedAnnounceGiveUp"];
  warn: SubagentLifecycleOptions["warn"];
  admissionRetryDelayMs: number;
}) {
  function scheduleSubagentDeliveryResumeRetry(
    runId: string,
    scheduledEntry: SubagentRunRecord,
    waitMs: number,
    stateContext = captureOpenClawStateWorkerContext(),
  ) {
    const generation = scheduledEntry.generation;
    const timer = setTimeout(() => {
      resumeRetryTimers.delete(timer);
      void runWithGatewayDetachedWorkAdmission(async () => {
        assertSubagentRegistryWriteSourceCurrent(stateContext);
        if (
          runs.get(runId) !== scheduledEntry ||
          scheduledEntry.generation !== generation ||
          scheduledEntry.cleanupHandled
        ) {
          return;
        }
        resumedRuns.delete(runId);
        resumeSubagentRun(runId);
      }, "subagents:resume-retry").catch((error: unknown) => {
        warn("failed to resume subagent delivery retry", { runId, error });
        if (
          runs.get(runId) !== scheduledEntry ||
          scheduledEntry.generation !== generation ||
          scheduledEntry.cleanupHandled
        ) {
          return;
        }
        try {
          assertSubagentRegistryWriteSourceCurrent(stateContext);
        } catch {
          resumedRuns.delete(runId);
          return;
        }
        if (
          isGatewayRestartDraining() &&
          runs.get(runId) === scheduledEntry &&
          typeof scheduledEntry.cleanupCompletedAt !== "number"
        ) {
          scheduleSubagentDeliveryResumeRetry(
            runId,
            scheduledEntry,
            Math.max(waitMs, admissionRetryDelayMs),
            stateContext,
          );
          return;
        }
        resumedRuns.delete(runId);
      });
    }, waitMs);
    timer.unref?.();
    resumeRetryTimers.add(timer);
  }

  function finalizeResumedAnnounceGiveUpInBackground(
    runId: string,
    entry: SubagentRunRecord,
    reason: "expiry" | "permanent_failure",
  ) {
    const stateContext = captureOpenClawStateWorkerContext();
    const generation = entry.generation;
    void runWithGatewayDetachedWorkAdmission(async () => {
      assertSubagentRegistryWriteSourceCurrent(stateContext);
      if (runs.get(runId) !== entry || entry.generation !== generation) {
        return;
      }
      await finalizeResumedAnnounceGiveUp({ runId, entry, reason, stateContext });
    }, "subagents:delivery-finalize").catch((error: unknown) => {
      warn("failed to finalize exhausted subagent delivery", { runId, reason, error });
      try {
        assertSubagentRegistryWriteSourceCurrent(stateContext);
      } catch {
        return;
      }
      if (
        isGatewayRestartDraining() &&
        runs.get(runId) === entry &&
        typeof entry.cleanupCompletedAt !== "number"
      ) {
        scheduleSubagentDeliveryResumeRetry(runId, entry, admissionRetryDelayMs, stateContext);
        resumedRuns.add(runId);
      }
    });
  }

  return { scheduleSubagentDeliveryResumeRetry, finalizeResumedAnnounceGiveUpInBackground };
}
