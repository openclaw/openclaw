import {
  isSystemEventStoreCurrent,
  recordSystemEventStoreReplaced,
} from "../../../infra/system-event-ownership.js";
import { defaultRuntime } from "../../../runtime.js";
import type { OpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.types.js";
import { blockSubagentCompletionDelivery } from "../completion/subagent-completion-admission.store.js";
import { getDeliveryLastError, isDeliverySuspended } from "./subagent-delivery-state.js";
import { logAnnounceGiveUp } from "./subagent-registry-helpers.js";
import {
  runWithSubagentCleanupWorkAdmission,
  retireSupersededCleanupIfNeeded,
} from "./subagent-registry-lifecycle-attempt.js";
import type {
  SubagentLifecycleAnnounceCleanupContext,
  SubagentLifecycleCleanupContext,
  SubagentLifecycleOptions,
  SubagentLifecycleWakeContext,
} from "./subagent-registry-lifecycle-context.js";
import { scheduleRequesterSettleWake } from "./subagent-registry-lifecycle-wake.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { assertSubagentRegistryWriteSourceCurrent } from "./subagent-registry-persistence.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

const pendingStoreRetirements = new WeakMap<SubagentRunRecord, Promise<void>>();

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

export function retireSupersededCleanupInBackground(
  context: SubagentLifecycleCleanupContext,
  runId: string,
  entry: SubagentRunRecord,
  generation: number,
  stateContext: OpenClawStateWorkerContext,
): void {
  // A late delivery callback still owns retirement through its original source.
  void runWithSubagentCleanupWorkAdmission(async () => {
    assertSubagentRegistryWriteSourceCurrent(stateContext);
    await retireSupersededCleanupIfNeeded(context, runId, entry, generation);
  }).catch((error: unknown) => {
    defaultRuntime.log(
      `[warn] subagent superseded cleanup retirement failed (${runId}): ${String(error)}`,
    );
  });
}
