import { runWithoutOwnedSessionTranscriptWrites } from "../../../config/sessions/transcript-write-context.js";
import { hasSqliteWorkerOutcomeUnknown } from "../../../infra/sqlite-worker-contract.js";
import {
  isGatewayRestartDraining,
  runWithGatewayDetachedWorkAdmission,
  runWithGatewayDetachedWorkContinuation,
} from "../../../process/gateway-work-admission.js";
import { defaultRuntime } from "../../../runtime.js";
import { captureOpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.js";
import type { OpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.types.js";
import { withoutGatewayToolCallerIdentity } from "../../tools/gateway-caller-context.js";
import {
  MIN_ANNOUNCE_RETRY_DELAY_MS,
  resolveAnnounceRetryDelayMs,
} from "./subagent-registry-helpers.js";
import type { SubagentLifecycleCleanupContext } from "./subagent-registry-lifecycle-context.js";
import { commitSubagentLifecycleMutation } from "./subagent-registry-lifecycle-persistence.js";
import {
  assertSubagentRegistryWriteSourceCurrent,
  SubagentRegistryWriteError,
} from "./subagent-registry-persistence.js";
import { subscribeSubagentRunChanges } from "./subagent-registry-publication.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

const MAX_DETACHED_CLEANUP_RETRIES = 3;

export function runWithSubagentCleanupWorkAdmission<T>(run: () => Promise<T>): Promise<T> {
  // Restart remains one-way; only suspension preserves an admitted cleanup owner.
  // The registry owns cleanup after the spawning tool's caller has retired.
  return withoutGatewayToolCallerIdentity(() =>
    isGatewayRestartDraining()
      ? runWithGatewayDetachedWorkAdmission(run, "subagents:lifecycle-cleanup")
      : runWithGatewayDetachedWorkContinuation(run, "subagents:lifecycle-cleanup"),
  );
}

export function scheduleResumeSubagentRun(
  context: SubagentLifecycleCleanupContext,
  runId: string,
  entry: SubagentRunRecord,
  delayMs: number,
  cleanupGeneration?: number,
  stateContext = captureOpenClawStateWorkerContext(),
): void {
  const params = context.options;
  const timer = setTimeout(() => {
    context.scheduledResumeTimers.delete(timer);
    void runWithGatewayDetachedWorkAdmission(async () => {
      assertSubagentRegistryWriteSourceCurrent(stateContext);
      if (params.runs.get(runId) !== entry) {
        return;
      }
      if (cleanupGeneration !== undefined) {
        if (!context.isCleanupGenerationCurrent(runId, entry, cleanupGeneration)) {
          return;
        }
        if (entry.cleanupHandled) {
          await commitSubagentLifecycleMutation(context, {
            entry,
            stateContext,
            assertCurrent() {
              if (!context.isCleanupGenerationCurrent(runId, entry, cleanupGeneration)) {
                throw new Error("Subagent cleanup resume generation changed.");
              }
            },
            mutate: () => {
              entry.cleanupHandled = false;
            },
            onPublished: () => params.resumedRuns.delete(runId),
          });
        }
      }
      assertSubagentRegistryWriteSourceCurrent(stateContext);
      if (
        params.runs.get(runId) !== entry ||
        (cleanupGeneration !== undefined &&
          !context.isCleanupGenerationCurrent(runId, entry, cleanupGeneration))
      ) {
        return;
      }
      params.resumedRuns.delete(runId);
      params.resumeSubagentRun(runId);
    }, "subagents:resume").catch((err: unknown) => {
      defaultRuntime.log(`[warn] subagent cleanup resume failed (${runId}): ${String(err)}`);
      const current = params.runs.get(runId);
      try {
        assertSubagentRegistryWriteSourceCurrent(stateContext);
      } catch {
        return;
      }
      if (
        isGatewayRestartDraining() &&
        current === entry &&
        typeof current.cleanupCompletedAt !== "number"
      ) {
        scheduleResumeSubagentRun(
          context,
          runId,
          entry,
          Math.max(delayMs, MIN_ANNOUNCE_RETRY_DELAY_MS),
          cleanupGeneration,
          stateContext,
        );
      }
    });
  }, delayMs);
  timer.unref?.();
  context.scheduledResumeTimers.add(timer);
}

export function runDetachedCleanupAttempt(
  context: SubagentLifecycleCleanupContext,
  args: {
    runId: string;
    entry: SubagentRunRecord;
    cleanupGeneration: number;
    stateContext: OpenClawStateWorkerContext;
    run: () => Promise<void>;
  },
): void {
  const params = context.options;
  const stateContext = args.stateContext;
  let startCommitted = false;
  let ownsReservation = true;
  const stopReservationObservation = subscribeSubagentRunChanges((runIds) => {
    if (runIds === undefined || runIds.includes(args.runId)) {
      ownsReservation = false;
    }
  });
  const releaseReservation = () => {
    if (
      startCommitted ||
      !ownsReservation ||
      args.entry.cleanupCompletedAt ||
      !context.isCleanupAttemptCurrent(args.runId, args.entry, args.cleanupGeneration)
    ) {
      return false;
    }
    // This releases process custody only; a later effect still needs fresh admission.
    args.entry.cleanupHandled = false;
    params.resumedRuns.delete(args.runId);
    return true;
  };
  const assertCurrent = () => {
    if (!context.isCleanupGenerationCurrent(args.runId, args.entry, args.cleanupGeneration)) {
      throw new Error("Subagent cleanup generation changed before persistence.");
    }
  };
  // The registry owns the full detached attempt through its final durable write.
  // Completion outlives the spawning attempt; inherited lock owners would
  // reject requester transcript writes after that attempt is disposed.
  runWithoutOwnedSessionTranscriptWrites(() => {
    void runWithSubagentCleanupWorkAdmission(async () => {
      try {
        // cleanupHandled is a process lock; effects still wait for the existing
        // start snapshot to commit through the captured writer.
        await commitSubagentLifecycleMutation(context, {
          entry: args.entry,
          stateContext,
          assertCurrent,
          mutate() {},
        });
        startCommitted = true;
        await args.run();
        if (context.isCleanupGeneration(args.entry, args.cleanupGeneration)) {
          context.cleanupFailureCounts.delete(args.entry);
        }
      } catch (err) {
        defaultRuntime.log(
          `[warn] subagent cleanup finalize failed (${args.runId}): ${String(err)}`,
        );
        if (hasSqliteWorkerOutcomeUnknown(err)) {
          throw err;
        }
        if (err instanceof SubagentRegistryWriteError && err.outcome === "committed") {
          if (err.publication === "superseded") {
            assertSubagentRegistryWriteSourceCurrent(stateContext);
            await retireSupersededCleanupIfNeeded(
              context,
              args.runId,
              args.entry,
              args.cleanupGeneration,
            );
          }
          throw err;
        }
        const current = params.runs.get(args.runId);
        if (
          !current ||
          current.cleanupCompletedAt ||
          !context.isCleanupAttemptCurrent(args.runId, args.entry, args.cleanupGeneration)
        ) {
          assertSubagentRegistryWriteSourceCurrent(stateContext);
          await retireSupersededCleanupIfNeeded(
            context,
            args.runId,
            args.entry,
            args.cleanupGeneration,
          );
          return;
        }
        if (startCommitted) {
          await commitSubagentLifecycleMutation(context, {
            entry: current,
            stateContext,
            assertCurrent,
            mutate: () => {
              current.cleanupHandled = false;
            },
            onPublished: () => params.resumedRuns.delete(args.runId),
          });
        } else if (!releaseReservation()) {
          return;
        }
        try {
          assertSubagentRegistryWriteSourceCurrent(stateContext);
        } catch {
          return;
        }
        if (!context.isCleanupGenerationCurrent(args.runId, args.entry, args.cleanupGeneration)) {
          return;
        }
        const failureCount = context.incrementCleanupFailureCount(current);
        if (failureCount <= MAX_DETACHED_CLEANUP_RETRIES) {
          scheduleResumeSubagentRun(
            context,
            args.runId,
            current,
            resolveAnnounceRetryDelayMs(failureCount),
            args.cleanupGeneration,
            stateContext,
          );
        }
      }
    })
      .catch((err: unknown) => {
        defaultRuntime.log(
          `[warn] subagent cleanup admission failed (${args.runId}): ${String(err)}`,
        );
        if (
          hasSqliteWorkerOutcomeUnknown(err) ||
          (err instanceof SubagentRegistryWriteError && err.outcome === "committed") ||
          (!startCommitted && !releaseReservation())
        ) {
          return;
        }
        try {
          assertSubagentRegistryWriteSourceCurrent(stateContext);
        } catch {
          return;
        }
        if (
          isGatewayRestartDraining() &&
          context.isCleanupGenerationCurrent(args.runId, args.entry, args.cleanupGeneration)
        ) {
          scheduleResumeSubagentRun(
            context,
            args.runId,
            args.entry,
            MIN_ANNOUNCE_RETRY_DELAY_MS,
            args.cleanupGeneration,
            stateContext,
          );
        }
      })
      .finally(stopReservationObservation);
  });
}

export function beginSubagentCleanup(
  context: SubagentLifecycleCleanupContext,
  runId: string,
): { cleanupGeneration: number; stateContext: OpenClawStateWorkerContext } | undefined {
  const params = context.options;
  const entry = params.runs.get(runId);
  if (
    !entry ||
    entry.pauseReason === "sessions_yield" ||
    entry.cleanupCompletedAt ||
    entry.cleanupHandled
  ) {
    return undefined;
  }
  // Failed source capture must not leave a reservation without an admitted driver.
  const stateContext = captureOpenClawStateWorkerContext();
  entry.cleanupHandled = true;
  return { cleanupGeneration: context.bumpCleanupGeneration(entry), stateContext };
}

export async function retireSupersededCleanupIfNeeded(
  context: SubagentLifecycleCleanupContext,
  runId: string,
  entry: SubagentRunRecord,
  generation: number,
): Promise<boolean> {
  const params = context.options;
  if (
    params.runs.get(runId) !== entry ||
    !context.isCleanupGeneration(entry, generation) ||
    !context.newerGenerationOwnsSession(entry)
  ) {
    return false;
  }
  // Cleanup can yield to attachment, mirror, or announce work. A successor
  // registered while it was suspended owns every session-scoped side effect.
  await params.retireSupersededRun(runId, entry);
  return true;
}
