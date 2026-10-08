import { runWithoutOwnedSessionTranscriptWrites } from "../../../config/sessions/transcript-write-context.js";
import { hasSqliteWorkerOutcomeUnknown } from "../../../infra/sqlite-worker-contract.js";
import {
  isSystemEventStoreCurrent,
  recordSystemEventStoreReplaced,
} from "../../../infra/system-event-ownership.js";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import {
  isGatewayRestartDraining,
  runWithGatewayDetachedWorkAdmission,
  runWithGatewayDetachedWorkContinuation,
} from "../../../process/gateway-work-admission.js";
import { defaultRuntime } from "../../../runtime.js";
import { captureOpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.js";
import type { OpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.types.js";
import { withoutGatewayToolCallerIdentity } from "../../tools/gateway-caller-context.js";
import { blockSubagentCompletionDelivery } from "../completion/subagent-completion-admission.store.js";
import { getDeliveryLastError, isDeliverySuspended } from "./subagent-delivery-state.js";
import { resolveAnnounceDeliveryDeadline } from "./subagent-registry-cleanup.js";
import {
  ANNOUNCE_COMPLETION_HARD_EXPIRY_MS,
  logAnnounceGiveUp,
  resolveAnnounceRetryDelayMs,
} from "./subagent-registry-helpers.js";
import type {
  SubagentLifecycleAnnounceCleanupContext,
  SubagentLifecycleCleanupContext,
  SubagentLifecycleOptions,
  SubagentLifecycleWakeContext,
} from "./subagent-registry-lifecycle-context.js";
import { commitSubagentLifecycleMutation } from "./subagent-registry-lifecycle-persistence.js";
import { scheduleRequesterSettleWake } from "./subagent-registry-lifecycle-wake.js";
import { getCurrentSubagentRunOwner, subagentRuns } from "./subagent-registry-memory.js";
import {
  assertSubagentRegistryWriteSourceCurrent,
  SubagentRegistryWriteError,
} from "./subagent-registry-persistence.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import { getSubagentRunRuntimeKey } from "./subagent-run-generation.js";

const pendingStoreRetirements = new Map<object, Promise<void>>();
const reportedOwnerlessStoreRetirements = new WeakSet<object>();
const log = createSubsystemLogger("agents/subagent-registry");

export async function suspendPendingFinalDelivery(
  context: SubagentLifecycleCleanupContext & SubagentLifecycleWakeContext,
  args: {
    runId: string;
    entry: SubagentRunRecord;
    reason: "expiry" | "permanent_failure";
    error?: string;
    enqueuedAt?: number;
    lastDropReason?: NonNullable<SubagentRunRecord["delivery"]>["lastDropReason"];
    storeReplaced?: true;
  },
): Promise<void> {
  const params = context.options;
  const currentEntry = getCurrentSubagentRunOwner(params.runs, args.entry);
  if (
    !currentEntry ||
    !(await blockSubagentCompletionDelivery({
      subagent: currentEntry,
      reason: args.error ?? getDeliveryLastError(currentEntry) ?? args.reason,
      suspendedReason: args.reason,
      lastDropReason: args.lastDropReason ?? currentEntry.delivery?.lastDropReason,
      enqueuedAt: args.enqueuedAt,
      storeReplaced: args.storeReplaced,
    }))
  ) {
    throw new Error(`subagent completion owner changed before suspension: ${args.runId}`);
  }
  const entry = getCurrentSubagentRunOwner(params.runs, args.entry);
  if (!entry) {
    return;
  }
  params.resumedRuns.delete(getSubagentRunRuntimeKey(args.entry));
  if (entry.delivery?.discardReason === "task-missing") {
    return;
  }
  logAnnounceGiveUp(entry, args.reason);
  // Suspension settles this child for requester drain while cleanup stays incomplete.
  scheduleRequesterSettleWake(context, entry.runId, entry);
}

export function isSubagentCompletionDeliveryAllowed(
  context: SubagentLifecycleAnnounceCleanupContext,
  observedEntry: SubagentRunRecord,
  cleanupGeneration: number,
  committedDeliveryOwner: SubagentRunRecord | undefined,
): boolean {
  const entry = getCurrentSubagentRunOwner(context.options.runs, observedEntry);
  if (!entry) {
    return false;
  }
  const committedDelivery = committedDeliveryOwner?.delivery;
  const ownsCommittedDelivery =
    committedDeliveryOwner !== undefined &&
    entry.requesterTurnRunId === committedDeliveryOwner.requesterTurnRunId &&
    entry.requesterTurnYielded === committedDeliveryOwner.requesterTurnYielded &&
    entry.requesterSettleWake?.rearmGeneration ===
      committedDeliveryOwner.requesterSettleWake?.rearmGeneration &&
    entry.requesterSettleWake?.batchRunIds?.toSorted().join("\0") ===
      committedDeliveryOwner.requesterSettleWake?.batchRunIds?.toSorted().join("\0");
  const { requesterSessionKey, requesterStorePath, requesterAgentId } = entry;
  const allowed =
    !subagentRuns.isCompletionAuthorityRetired(entry) &&
    entry.suppressCompletionDelivery !== true &&
    !isDeliverySuspended(entry) &&
    (entry.delivery?.status !== "delivered" ||
      (ownsCommittedDelivery &&
        committedDelivery?.status === "delivered" &&
        committedDelivery.generation === entry.delivery.generation &&
        committedDelivery.deliveredAt === entry.delivery.deliveredAt)) &&
    context.isCleanupAttemptCurrent(entry, cleanupGeneration);
  if (
    !allowed ||
    isSystemEventStoreCurrent(requesterSessionKey, requesterStorePath, requesterAgentId)
  ) {
    return allowed;
  }
  if (entry.expectsCompletionMessage === true) {
    subagentRuns.retireCompletionAuthority(entry);
  }
  return false;
}

export function suspendReplacedStoreNotifications(
  options: SubagentLifecycleOptions,
): Promise<void> {
  // Capture retirement before yielding: restoring the old selector cannot revive these notifications.
  const pending = new Set<Promise<void>>();
  const entries = [...options.runs.values()]
    .filter((entry) => {
      const work = pendingStoreRetirements.get(getSubagentRunRuntimeKey(entry));
      if (!work) {
        return true;
      }
      pending.add(work);
      return false;
    })
    .filter((entry) => {
      const { delivery, requesterSessionKey, requesterStorePath, requesterAgentId } = entry;
      return (
        delivery &&
        ["pending", "in_progress"].includes(delivery.status) &&
        delivery.deliveredAt === undefined &&
        delivery.announcedAt === undefined &&
        entry.execution.status === "terminal" &&
        entry.expectsCompletionMessage === true &&
        !isSystemEventStoreCurrent(requesterSessionKey, requesterStorePath, requesterAgentId)
      );
    })
    .map((entry) => ({
      entry,
      deliveryGeneration: entry.delivery?.generation,
    }));
  if (!entries.length) {
    return Promise.all(pending).then(() => {});
  }
  entries.forEach(({ entry }) => subagentRuns.retireCompletionAuthority(entry));
  const work = runWithSubagentCleanupWorkAdmission(async () => {
    for (const { entry, deliveryGeneration } of entries) {
      let current = getCurrentSubagentRunOwner(options.runs, entry);
      if (!current || current.delivery?.generation !== deliveryGeneration) {
        continue;
      }
      if (
        !(await blockSubagentCompletionDelivery({
          subagent: current,
          reason: "store replaced",
          suspendedReason: "permanent_failure",
          storeReplaced: true,
        }))
      ) {
        const owner = getSubagentRunRuntimeKey(entry);
        if (!reportedOwnerlessStoreRetirements.has(owner)) {
          reportedOwnerlessStoreRetirements.add(owner);
          log.info("subagent notification store retirement has no current native owner", {
            runId: entry.runId,
          });
        }
        continue;
      }
      current = getCurrentSubagentRunOwner(options.runs, entry);
      if (!current || current.delivery?.generation !== deliveryGeneration) {
        continue;
      }
      options.resumedRuns.delete(getSubagentRunRuntimeKey(entry));
      recordSystemEventStoreReplaced();
    }
  }).finally(() => {
    for (const { entry } of entries) {
      pendingStoreRetirements.delete(getSubagentRunRuntimeKey(entry));
    }
  });
  for (const { entry } of entries) {
    pendingStoreRetirements.set(getSubagentRunRuntimeKey(entry), work);
  }
  pending.add(work);
  return Promise.all(pending).then(() => {});
}

const MAX_DETACHED_CLEANUP_RETRIES = 3;

type SubagentCleanupAttempt = {
  cleanupGeneration: number;
  stateContext: OpenClawStateWorkerContext;
};

export function runWithSubagentCleanupWorkAdmission<T>(run: () => Promise<T>): Promise<T> {
  // Required cleanup continues under its admitted owner after ingress closes.
  return withoutGatewayToolCallerIdentity(() =>
    runWithGatewayDetachedWorkContinuation(run, "subagents:lifecycle-cleanup"),
  );
}

export function scheduleResumeSubagentRun(
  context: SubagentLifecycleCleanupContext,
  entry: SubagentRunRecord,
  delayMs: number,
  cleanupGeneration?: number,
  stateContext = captureOpenClawStateWorkerContext(),
): void {
  const params = context.options;
  const runtimeKey = getSubagentRunRuntimeKey(entry);
  const currentRun = () => {
    assertSubagentRegistryWriteSourceCurrent(stateContext);
    const current = getCurrentSubagentRunOwner(params.runs, entry);
    return current &&
      (cleanupGeneration === undefined
        ? !current.cleanupHandled
        : context.isCleanupGenerationCurrent(entry, cleanupGeneration))
      ? current
      : undefined;
  };
  if (!currentRun()) {
    return;
  }
  clearTimeout(context.scheduledResumeTimers.get(runtimeKey));
  const currentOwner = () =>
    context.scheduledResumeTimers.get(runtimeKey) === timer ? currentRun() : undefined;
  const timer = setTimeout(() => {
    const run =
      cleanupGeneration === undefined
        ? runWithGatewayDetachedWorkAdmission
        : runWithSubagentCleanupWorkAdmission;
    void run(async () => {
      const current = currentOwner();
      if (!current) {
        return;
      }
      if (current.cleanupHandled) {
        await commitSubagentLifecycleMutation(context, {
          entry,
          stateContext,
          assertCurrent() {
            if (!currentOwner()) {
              throw new Error("Subagent cleanup resume owner changed.");
            }
          },
          mutate: (draft) => {
            draft.cleanupHandled = false;
          },
        });
      }
      const resumedEntry = currentOwner();
      if (resumedEntry) {
        context.scheduledResumeTimers.delete(runtimeKey);
        params.resumedRuns.delete(runtimeKey);
        params.resumeSubagentRun(resumedEntry.runId);
      }
    })
      .catch((err: unknown) => {
        params.warn("subagent delivery resume failed", { runId: entry.runId, error: err });
        try {
          if (isGatewayRestartDraining() && currentOwner()) {
            scheduleResumeSubagentRun(
              context,
              entry,
              Math.max(delayMs, 1_000),
              cleanupGeneration,
              stateContext,
            );
          }
        } catch {
          // A replaced state owner cannot retain this retry.
        }
      })
      .finally(() => {
        if (context.scheduledResumeTimers.get(runtimeKey) === timer) {
          context.scheduledResumeTimers.delete(runtimeKey);
          params.resumedRuns.delete(runtimeKey);
        }
      });
  }, delayMs);
  timer.unref?.();
  context.scheduledResumeTimers.set(runtimeKey, timer);
}

export function runDetachedCleanupAttempt(
  context: SubagentLifecycleCleanupContext,
  entry: SubagentRunRecord,
  { cleanupGeneration, stateContext }: SubagentCleanupAttempt,
  run: () => Promise<void>,
): void {
  const params = context.options;
  const runId = entry.runId;
  let startCommitted = false;
  const identity = getSubagentRunRuntimeKey(entry);
  context.activeCleanupAttempts.set(
    identity,
    (context.activeCleanupAttempts.get(identity) ?? 0) + 1,
  );
  const releaseReservation = () => {
    if (!context.isCleanupGeneration(entry, cleanupGeneration)) {
      return;
    }
    context.cleanupReservations.delete(identity);
    if (!startCommitted) {
      params.resumedRuns.delete(identity);
    }
  };
  const assertCurrent = () => {
    if (!context.isCleanupGenerationCurrent(entry, cleanupGeneration)) {
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
          entry,
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
        await run();
        if (context.isCleanupGeneration(entry, cleanupGeneration)) {
          context.cleanupFailureCounts.delete(identity);
        }
      } catch (err) {
        defaultRuntime.log(`[warn] subagent cleanup finalize failed (${runId}): ${String(err)}`);
        if (hasSqliteWorkerOutcomeUnknown(err)) {
          throw err;
        }
        if (err instanceof SubagentRegistryWriteError && err.outcome === "committed") {
          if (err.publication === "superseded") {
            assertSubagentRegistryWriteSourceCurrent(stateContext);
            await retireSupersededCleanupIfNeeded(context, entry, cleanupGeneration);
          }
          throw err;
        }
        const current = getCurrentSubagentRunOwner(params.runs, entry);
        if (
          !current ||
          current.cleanupCompletedAt ||
          !(startCommitted
            ? context.isCleanupAttemptCurrent(entry, cleanupGeneration)
            : context.isCleanupGenerationCurrent(entry, cleanupGeneration))
        ) {
          assertSubagentRegistryWriteSourceCurrent(stateContext);
          await retireSupersededCleanupIfNeeded(context, entry, cleanupGeneration);
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
        if (!context.isCleanupGenerationCurrent(entry, cleanupGeneration)) {
          return;
        }
        const failureCount = context.incrementCleanupFailureCount(current);
        const requiredDeliveryPending =
          current.expectsCompletionMessage === true && current.delivery?.status === "pending";
        const remainingDeliveryMs = requiredDeliveryPending
          ? resolveAnnounceDeliveryDeadline(
              current,
              Date.now(),
              ANNOUNCE_COMPLETION_HARD_EXPIRY_MS,
            ) - Date.now()
          : 0;
        // Expiry closes sending, not the pending obligation to record its disposition.
        if (requiredDeliveryPending || failureCount <= MAX_DETACHED_CLEANUP_RETRIES) {
          scheduleResumeSubagentRun(
            context,
            current,
            remainingDeliveryMs > 0
              ? Math.min(remainingDeliveryMs, resolveAnnounceRetryDelayMs(failureCount))
              : resolveAnnounceRetryDelayMs(failureCount),
            cleanupGeneration,
            stateContext,
          );
        }
      }
    })
      .catch((err: unknown) => {
        defaultRuntime.log(`[warn] subagent cleanup admission failed (${runId}): ${String(err)}`);
      })
      .finally(() => {
        releaseReservation();
        const active = (context.activeCleanupAttempts.get(identity) ?? 1) - 1;
        if (active > 0) {
          context.activeCleanupAttempts.set(identity, active);
        } else {
          context.activeCleanupAttempts.delete(identity);
        }
        context.pruneRetiredRuns([runId]);
      });
  });
}

export function beginSubagentCleanup(
  context: SubagentLifecycleCleanupContext,
  runId: string,
): SubagentCleanupAttempt | undefined {
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
