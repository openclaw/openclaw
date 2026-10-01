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
import { getSubagentRunRuntimeKey, isSameSubagentRunOwner } from "./subagent-run-generation.js";

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
  resumedRuns: Set<object>;
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
    const resumeKey = getSubagentRunRuntimeKey(scheduledEntry);
    const timer = setTimeout(() => {
      resumeRetryTimers.delete(timer);
      void runWithGatewayDetachedWorkAdmission(async () => {
        assertSubagentRegistryWriteSourceCurrent(stateContext);
        const current = runs.get(runId);
        if (!isSameSubagentRunOwner(current, scheduledEntry)) {
          resumedRuns.delete(resumeKey);
          return;
        }
        if (current?.cleanupHandled) {
          return;
        }
        resumedRuns.delete(resumeKey);
        resumeSubagentRun(runId);
      }, "subagents:resume-retry").catch((error: unknown) => {
        warn("failed to resume subagent delivery retry", { runId, error });
        const current = runs.get(runId);
        if (!isSameSubagentRunOwner(current, scheduledEntry)) {
          resumedRuns.delete(resumeKey);
          return;
        }
        if (current?.cleanupHandled) {
          return;
        }
        try {
          assertSubagentRegistryWriteSourceCurrent(stateContext);
        } catch {
          resumedRuns.delete(resumeKey);
          return;
        }
        if (
          isGatewayRestartDraining() &&
          isSameSubagentRunOwner(runs.get(runId), scheduledEntry) &&
          typeof runs.get(runId)?.cleanupCompletedAt !== "number"
        ) {
          scheduleSubagentDeliveryResumeRetry(
            runId,
            scheduledEntry,
            Math.max(waitMs, admissionRetryDelayMs),
            stateContext,
          );
          return;
        }
        resumedRuns.delete(resumeKey);
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
    const resumeKey = getSubagentRunRuntimeKey(entry);
    void runWithGatewayDetachedWorkAdmission(async () => {
      assertSubagentRegistryWriteSourceCurrent(stateContext);
      if (!isSameSubagentRunOwner(runs.get(runId), entry)) {
        resumedRuns.delete(resumeKey);
        return;
      }
      const current = runs.get(runId);
      if (current) {
        await finalizeResumedAnnounceGiveUp({ runId, entry: current, reason, stateContext });
      }
    }, "subagents:delivery-finalize").catch((error: unknown) => {
      warn("failed to finalize exhausted subagent delivery", { runId, reason, error });
      try {
        assertSubagentRegistryWriteSourceCurrent(stateContext);
      } catch {
        return;
      }
      if (
        isGatewayRestartDraining() &&
        isSameSubagentRunOwner(runs.get(runId), entry) &&
        typeof runs.get(runId)?.cleanupCompletedAt !== "number"
      ) {
        scheduleSubagentDeliveryResumeRetry(runId, entry, admissionRetryDelayMs, stateContext);
        resumedRuns.add(resumeKey);
      }
    });
  }

  return { scheduleSubagentDeliveryResumeRetry, finalizeResumedAnnounceGiveUpInBackground };
}
