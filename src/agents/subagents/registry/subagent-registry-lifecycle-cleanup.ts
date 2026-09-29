import { runWithoutOwnedSessionTranscriptWrites } from "../../../config/sessions/transcript-write-context.js";
import {
  isSystemEventStoreCurrent,
  recordSystemEventStoreReplaced,
} from "../../../infra/system-event-ownership.js";
import {
  isGatewayRestartDraining,
  runWithGatewayIndependentRootWorkAdmission,
  runWithGatewayIndependentRootWorkContinuation,
} from "../../../process/gateway-work-admission.js";
import { defaultRuntime } from "../../../runtime.js";
import { withoutGatewayToolCallerIdentity } from "../../tools/gateway-caller-context.js";
import { blockSubagentCompletionDelivery } from "../completion/subagent-completion-admission.store.js";
import { getDeliveryLastError, isDeliverySuspended } from "./subagent-delivery-state.js";
import {
  logAnnounceGiveUp,
  MIN_ANNOUNCE_RETRY_DELAY_MS,
  resolveAnnounceRetryDelayMs,
} from "./subagent-registry-helpers.js";
import type {
  SubagentLifecycleAnnounceCleanupContext,
  SubagentLifecycleCleanupContext,
  SubagentLifecycleOptions,
  SubagentLifecycleWakeContext,
} from "./subagent-registry-lifecycle-context.js";
import { scheduleRequesterSettleWake } from "./subagent-registry-lifecycle-wake.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

const MAX_DETACHED_CLEANUP_RETRIES = 3;
const pendingStoreRetirements = new WeakMap<SubagentRunRecord, Promise<void>>();

function runWithSubagentCleanupWorkAdmission<T>(run: () => Promise<T>): Promise<T> {
  // Restart remains one-way; only suspension preserves an admitted cleanup owner.
  // The registry owns cleanup after the spawning tool's caller has retired.
  return withoutGatewayToolCallerIdentity(() =>
    isGatewayRestartDraining()
      ? runWithGatewayIndependentRootWorkAdmission(run, "subagents:lifecycle-cleanup")
      : runWithGatewayIndependentRootWorkContinuation(run, "subagents:lifecycle-cleanup"),
  );
}

export function scheduleResumeSubagentRun(
  context: SubagentLifecycleCleanupContext,
  runId: string,
  entry: SubagentRunRecord,
  delayMs: number,
  cleanupGeneration?: number,
): void {
  const params = context.options;
  const timer = setTimeout(() => {
    context.scheduledResumeTimers.delete(timer);
    void runWithGatewayIndependentRootWorkAdmission(async () => {
      if (params.runs.get(runId) !== entry) {
        return;
      }
      if (cleanupGeneration !== undefined) {
        if (!context.isCleanupGenerationCurrent(runId, entry, cleanupGeneration)) {
          return;
        }
        if (entry.cleanupHandled) {
          entry.cleanupHandled = false;
          params.persist(runId);
        }
      }
      params.resumedRuns.delete(runId);
      params.resumeSubagentRun(runId);
    }, "subagents:resume").catch((err: unknown) => {
      defaultRuntime.log(`[warn] subagent cleanup resume failed (${runId}): ${String(err)}`);
      const current = params.runs.get(runId);
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
    run: () => Promise<void>;
  },
): void {
  const params = context.options;
  // Completion makes the task projection non-blocking before delivery and
  // cleanup finish. This independent lease bridges that handoff and owns the
  // full detached attempt, including its final durable registry write.
  // Completion outlives the spawning attempt; inherited lock owners would
  // reject requester transcript writes after that attempt is disposed.
  runWithoutOwnedSessionTranscriptWrites(() => {
    void runWithSubagentCleanupWorkAdmission(async () => {
      try {
        await args.run();
        context.cleanupFailureCounts.delete(args.entry);
      } catch (err) {
        defaultRuntime.log(
          `[warn] subagent cleanup finalize failed (${args.runId}): ${String(err)}`,
        );
        const current = params.runs.get(args.runId);
        if (
          !current ||
          current.cleanupCompletedAt ||
          !context.isCleanupAttemptCurrent(args.runId, args.entry, args.cleanupGeneration)
        ) {
          return;
        }
        current.cleanupHandled = false;
        params.resumedRuns.delete(args.runId);
        params.persist(args.runId);
        const failureCount = context.incrementCleanupFailureCount(current);
        if (failureCount <= MAX_DETACHED_CLEANUP_RETRIES) {
          scheduleResumeSubagentRun(
            context,
            args.runId,
            current,
            resolveAnnounceRetryDelayMs(failureCount),
            args.cleanupGeneration,
          );
        }
      }
    }).catch((err: unknown) => {
      defaultRuntime.log(
        `[warn] subagent cleanup admission failed (${args.runId}): ${String(err)}`,
      );
      if (isGatewayRestartDraining()) {
        scheduleResumeSubagentRun(
          context,
          args.runId,
          args.entry,
          MIN_ANNOUNCE_RETRY_DELAY_MS,
          args.cleanupGeneration,
        );
      }
    });
  });
}

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
  const generation = args.entry.generation;
  const committed = await blockSubagentCompletionDelivery({
    subagent: args.entry,
    reason: args.error ?? getDeliveryLastError(args.entry) ?? args.reason,
    suspendedReason: args.reason,
    lastDropReason: args.lastDropReason ?? args.entry.delivery?.lastDropReason,
    enqueuedAt: args.enqueuedAt,
    storeReplaced: args.storeReplaced,
  });
  if (!committed) {
    throw new Error(`subagent completion owner changed before suspension: ${args.runId}`);
  }
  if (params.runs.get(args.runId) !== args.entry || args.entry.generation !== generation) {
    return;
  }
  params.resumedRuns.delete(args.runId);
  if (args.entry.delivery?.discardReason === "task-missing") {
    return;
  }
  logAnnounceGiveUp(args.entry, args.reason);
  // Suspension settles this child for requester drain while cleanup stays incomplete.
  scheduleRequesterSettleWake(context, args.runId, args.entry);
}

export function isSubagentCompletionDeliveryAllowed(
  context: SubagentLifecycleAnnounceCleanupContext,
  entry: SubagentRunRecord,
  cleanupGeneration: number,
  committedDelivery: SubagentRunRecord["delivery"],
): boolean {
  const { runId, requesterSessionKey, requesterStorePath, requesterAgentId } = entry;
  const allowed =
    !subagentRuns.isCompletionAuthorityRetired(entry) &&
    entry.suppressCompletionDelivery !== true &&
    !isDeliverySuspended(entry) &&
    (entry.delivery?.status !== "delivered" || entry.delivery === committedDelivery) &&
    context.isCleanupAttemptCurrent(runId, entry, cleanupGeneration);
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
      const work = pendingStoreRetirements.get(entry);
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
      generation: entry.generation,
      deliveryGeneration: entry.delivery?.generation,
    }));
  if (!entries.length) {
    return Promise.all(pending).then(() => {});
  }
  entries.forEach(({ entry }) => subagentRuns.retireCompletionAuthority(entry));
  const work = runWithSubagentCleanupWorkAdmission(async () => {
    for (const { entry, generation, deliveryGeneration } of entries) {
      if (
        options.runs.get(entry.runId) !== entry ||
        entry.generation !== generation ||
        entry.delivery?.generation !== deliveryGeneration
      ) {
        continue;
      }
      if (
        !(await blockSubagentCompletionDelivery({
          subagent: entry,
          reason: "store replaced",
          suspendedReason: "permanent_failure",
          storeReplaced: true,
        }))
      ) {
        options.warn("subagent notification store retirement has no current native owner", {
          runId: entry.runId,
        });
        continue;
      }
      if (
        options.runs.get(entry.runId) !== entry ||
        entry.generation !== generation ||
        entry.delivery?.generation !== deliveryGeneration
      ) {
        continue;
      }
      options.resumedRuns.delete(entry.runId);
      recordSystemEventStoreReplaced();
    }
  }).finally(() => {
    for (const { entry } of entries) {
      pendingStoreRetirements.delete(entry);
    }
  });
  for (const { entry } of entries) {
    pendingStoreRetirements.set(entry, work);
  }
  pending.add(work);
  return Promise.all(pending).then(() => {});
}

export function beginSubagentCleanup(
  context: SubagentLifecycleCleanupContext,
  runId: string,
): number | undefined {
  const params = context.options;
  const entry = params.runs.get(runId);
  if (!entry || entry.cleanupCompletedAt || entry.cleanupHandled) {
    return undefined;
  }
  entry.cleanupHandled = true;
  const generation = context.bumpCleanupGeneration(entry);
  params.persist(runId);
  return generation;
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

export function retireSupersededCleanupInBackground(
  context: SubagentLifecycleCleanupContext,
  runId: string,
  entry: SubagentRunRecord,
  generation: number,
): void {
  // Delivery callbacks are synchronous and may arrive after their announce
  // attempt returns. Give the async retirement tail its own snapshot blocker.
  void runWithSubagentCleanupWorkAdmission(async () => {
    await retireSupersededCleanupIfNeeded(context, runId, entry, generation);
  }).catch((error: unknown) => {
    defaultRuntime.log(
      `[warn] subagent superseded cleanup retirement failed (${runId}): ${String(error)}`,
    );
  });
}
