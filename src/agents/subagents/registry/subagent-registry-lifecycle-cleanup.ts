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
import { getCurrentSubagentRunOwner, subagentRuns } from "./subagent-registry-memory.js";
import { assertSubagentRegistryWriteSourceCurrent } from "./subagent-registry-persistence.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import { getSubagentRunRuntimeKey } from "./subagent-run-generation.js";

const pendingStoreRetirements = new Map<object, Promise<void>>();

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
  if (!currentEntry) {
    throw new Error(`subagent completion owner changed before suspension: ${args.runId}`);
  }
  const committed = await blockSubagentCompletionDelivery({
    subagent: currentEntry,
    reason: args.error ?? getDeliveryLastError(currentEntry) ?? args.reason,
    suspendedReason: args.reason,
    lastDropReason: args.lastDropReason ?? currentEntry.delivery?.lastDropReason,
    enqueuedAt: args.enqueuedAt,
    storeReplaced: args.storeReplaced,
  });
  if (!committed) {
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
        options.warn("subagent notification store retirement has no current native owner", {
          runId: entry.runId,
        });
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
    await retireSupersededCleanupIfNeeded(context, entry, generation);
  }).catch((error: unknown) => {
    defaultRuntime.log(
      `[warn] subagent superseded cleanup retirement failed (${runId}): ${String(error)}`,
    );
  });
}
