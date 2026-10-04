import { runWithoutOwnedSessionTranscriptWrites } from "../../../config/sessions/transcript-write-context.js";
import { hasSqliteWorkerOutcomeUnknown } from "../../../infra/sqlite-worker-contract.js";
import { runWithGatewayDetachedWorkContinuation } from "../../../process/gateway-work-admission.js";
import { defaultRuntime } from "../../../runtime.js";
import { captureOpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.js";
import type { OpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.types.js";
import { withoutGatewayToolCallerIdentity } from "../../tools/gateway-caller-context.js";
import { resolveAnnounceRetryDelayMs } from "./subagent-registry-helpers.js";
import type { SubagentLifecycleCleanupContext } from "./subagent-registry-lifecycle-context.js";
import { commitSubagentLifecycleMutation } from "./subagent-registry-lifecycle-persistence.js";
import { getCurrentSubagentRunOwner } from "./subagent-registry-memory.js";
import {
  assertSubagentRegistryWriteSourceCurrent,
  SubagentRegistryWriteError,
} from "./subagent-registry-persistence.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import { getSubagentRunRuntimeKey } from "./subagent-run-generation.js";

const MAX_DETACHED_CLEANUP_RETRIES = 3;

export function runWithSubagentCleanupWorkAdmission<T>(run: () => Promise<T>): Promise<T> {
  // Required cleanup continues under its admitted owner after ingress closes.
  return withoutGatewayToolCallerIdentity(() =>
    runWithGatewayDetachedWorkContinuation(run, "subagents:lifecycle-cleanup"),
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
  const runtimeKey = getSubagentRunRuntimeKey(entry);
  const timer = setTimeout(() => {
    context.scheduledResumeTimers.delete(timer);
    void runWithSubagentCleanupWorkAdmission(async () => {
      assertSubagentRegistryWriteSourceCurrent(stateContext);
      const current = getCurrentSubagentRunOwner(params.runs, entry);
      if (!current) {
        return;
      }
      if (cleanupGeneration !== undefined) {
        if (!context.isCleanupGenerationCurrent(runId, entry, cleanupGeneration)) {
          return;
        }
        if (current.cleanupHandled) {
          await commitSubagentLifecycleMutation(context, {
            entry,
            stateContext,
            assertCurrent() {
              if (!context.isCleanupGenerationCurrent(runId, entry, cleanupGeneration)) {
                throw new Error("Subagent cleanup resume generation changed.");
              }
            },
            mutate: (draft) => {
              draft.cleanupHandled = false;
            },
            onPublished: () => params.resumedRuns.delete(runtimeKey),
          });
        }
      }
      assertSubagentRegistryWriteSourceCurrent(stateContext);
      const resumedEntry = getCurrentSubagentRunOwner(params.runs, entry);
      if (
        !resumedEntry ||
        (cleanupGeneration !== undefined &&
          !context.isCleanupGenerationCurrent(runId, entry, cleanupGeneration))
      ) {
        return;
      }
      params.resumedRuns.delete(runtimeKey);
      params.resumeSubagentRun(resumedEntry.runId);
    }).catch((err: unknown) => {
      defaultRuntime.log(`[warn] subagent cleanup resume failed (${runId}): ${String(err)}`);
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
  const identity = getSubagentRunRuntimeKey(args.entry);
  context.activeCleanupAttempts.set(
    identity,
    (context.activeCleanupAttempts.get(identity) ?? 0) + 1,
  );
  const releaseReservation = () => {
    if (!context.isCleanupGeneration(args.entry, args.cleanupGeneration)) {
      return;
    }
    context.cleanupReservations.delete(identity);
    if (!startCommitted) {
      params.resumedRuns.delete(identity);
    }
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
        await commitSubagentLifecycleMutation(context, {
          entry: args.entry,
          stateContext,
          assertCurrent,
          mutate(draft) {
            if (draft.pauseReason === "sessions_yield" || draft.cleanupCompletedAt) {
              throw new Error("Subagent cleanup is no longer pending.");
            }
            draft.cleanupHandled = true;
          },
        });
        startCommitted = true;
        releaseReservation();
        await args.run();
        if (context.isCleanupGeneration(args.entry, args.cleanupGeneration)) {
          context.cleanupFailureCounts.delete(identity);
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
            await retireSupersededCleanupIfNeeded(context, args.entry, args.cleanupGeneration);
          }
          throw err;
        }
        const current = getCurrentSubagentRunOwner(params.runs, args.entry);
        if (
          !current ||
          current.cleanupCompletedAt ||
          !(startCommitted
            ? context.isCleanupAttemptCurrent(args.runId, args.entry, args.cleanupGeneration)
            : context.isCleanupGenerationCurrent(args.runId, args.entry, args.cleanupGeneration))
        ) {
          assertSubagentRegistryWriteSourceCurrent(stateContext);
          await retireSupersededCleanupIfNeeded(context, args.entry, args.cleanupGeneration);
          return;
        }
        if (startCommitted) {
          await commitSubagentLifecycleMutation(context, {
            entry: current,
            stateContext,
            assertCurrent,
            mutate: (draft) => {
              draft.cleanupHandled = false;
            },
            onPublished: () => params.resumedRuns.delete(identity),
          });
        } else {
          releaseReservation();
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
            current.runId,
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
      })
      .finally(() => {
        releaseReservation();
        const active = (context.activeCleanupAttempts.get(identity) ?? 1) - 1;
        if (active > 0) {
          context.activeCleanupAttempts.set(identity, active);
        } else {
          context.activeCleanupAttempts.delete(identity);
        }
        context.pruneRetiredRuns([args.runId]);
      });
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
    entry.cleanupHandled ||
    context.cleanupReservations.has(getSubagentRunRuntimeKey(entry))
  ) {
    return undefined;
  }
  // Failed source capture must not leave a reservation without an admitted driver.
  const stateContext = captureOpenClawStateWorkerContext();
  context.cleanupReservations.add(getSubagentRunRuntimeKey(entry));
  return { cleanupGeneration: context.bumpCleanupGeneration(entry), stateContext };
}

export async function retireSupersededCleanupIfNeeded(
  context: SubagentLifecycleCleanupContext,
  entry: SubagentRunRecord,
  generation: number,
): Promise<boolean> {
  const params = context.options;
  const current = getCurrentSubagentRunOwner(params.runs, entry);
  if (
    !current ||
    !context.isCleanupGeneration(entry, generation) ||
    !context.newerGenerationOwnsSession(current)
  ) {
    return false;
  }
  // Cleanup can yield to attachment, mirror, or announce work. A successor
  // registered while it was suspended owns every session-scoped side effect.
  await params.retireSupersededRun(current.runId, current);
  return true;
}
