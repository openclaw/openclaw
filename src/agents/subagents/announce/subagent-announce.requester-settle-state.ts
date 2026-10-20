import type { DeliveryContext } from "../../../utils/delivery-context.shared.js";
import type {
  RequesterSettleWakeState,
  SubagentRunRecord,
} from "../registry/subagent-registry.types.js";
import { isSubagentObligationRetired } from "../registry/subagent-requester-settle-identity.js";
import { isSameSubagentRun, isSameSubagentRunOwner } from "../registry/subagent-run-generation.js";
import type { SubagentAnnounceDeliveryResult } from "./subagent-announce-dispatch.js";

export type RequesterSettleWakeBatchState = Omit<RequesterSettleWakeState, "retireAfterSettle">;

export const REQUESTER_SETTLE_WAKE_MAX_ATTEMPTS = 3;
const REQUESTER_SETTLE_WAKE_RETRY_DELAYS_MS = [30_000, 120_000] as const;

/** Only a known missing result may mint another public continuation; private retries reconcile. */
export function resolveRequesterSettleRetryState(params: {
  state: RequesterSettleWakeBatchState;
  delivery: SubagentAnnounceDeliveryResult;
  attemptCount: number;
  parentOnly: boolean;
  now: number;
}): RequesterSettleWakeBatchState | undefined {
  const { state, delivery, attemptCount, parentOnly } = params;
  const retryDelay = REQUESTER_SETTLE_WAKE_RETRY_DELAYS_MS[attemptCount - 1];
  if (
    delivery.disposition !== "retryable" ||
    (!parentOnly && delivery.reason !== "visible_reply_missing") ||
    delivery.reason === "requester_abandoned" ||
    attemptCount >= REQUESTER_SETTLE_WAKE_MAX_ATTEMPTS ||
    retryDelay === undefined
  ) {
    return undefined;
  }
  return {
    ...state,
    status: "pending",
    attemptCount,
    nextAttemptAt: params.now + retryDelay,
    lastError: delivery.error ?? delivery.reason ?? "undelivered",
  };
}

type RequesterSettleWakeBatchCallbacks = {
  transitionBatch: (
    batch: readonly SubagentRunRecord[],
    state: RequesterSettleWakeBatchState,
    onPublished?: (entries: readonly SubagentRunRecord[]) => void,
  ) => void | Promise<void>;
  completeBatch: (
    batch: readonly SubagentRunRecord[],
    rearmGeneration?: number,
    delivery?: SubagentAnnounceDeliveryResult,
    onCommitted?: () => void | Promise<void>,
  ) => void | Promise<void>;
};

export type RequesterSettleWakeParams = RequesterSettleWakeBatchCallbacks & {
  requesterSessionKey: string;
  requesterOrigin?: DeliveryContext;
  settledEntry: SubagentRunRecord;
  signal?: AbortSignal;
  isSourceCurrent: () => boolean;
  onDescendantsPending?: (deadline?: number) => void;
};

export function waitForRequesterDescendants(
  facts: { unsettled: boolean; active: number; deliveryWaitUntil?: number },
  frozen: boolean,
  onPending?: (deadline?: number) => void,
): boolean {
  const active = !frozen || facts.active > 0;
  if (!facts.unsettled || (!active && (facts.deliveryWaitUntil ?? 0) <= Date.now())) {
    return false;
  }
  onPending?.(active ? undefined : facts.deliveryWaitUntil);
  return true;
}

export function readSharedBatchState(
  batch: readonly SubagentRunRecord[],
): RequesterSettleWakeBatchState {
  const states = batch
    .map((entry) => entry.requesterSettleWake)
    .filter((state): state is RequesterSettleWakeState => Boolean(state));
  const source = states.find((state) => state.status === "dispatching") ?? states[0];
  return {
    status: source?.status ?? "pending",
    attemptCount: Math.max(0, ...states.map((state) => state.attemptCount ?? 0)),
    ...(source?.privateInput ? { privateInput: source.privateInput } : {}),
    ...(source?.replayCount !== undefined ? { replayCount: source.replayCount } : {}),
    ...(source?.nextAttemptAt !== undefined ? { nextAttemptAt: source.nextAttemptAt } : {}),
    ...(source?.lastError !== undefined ? { lastError: source.lastError } : {}),
    ...(source?.progressOperationId ? { progressOperationId: source.progressOperationId } : {}),
    ...(source?.pauseNotice ? { pauseNotice: source.pauseNotice } : {}),
    ...(source?.batchRunIds ? { batchRunIds: [...source.batchRunIds] } : {}),
    ...(states.some((state) => state.requesterYieldBatch === true)
      ? { requesterYieldBatch: true }
      : {}),
    ...(states.some((state) => state.afterRequesterYield === true)
      ? { afterRequesterYield: true }
      : {}),
    ...(source?.yieldedFinalDeliverable === true ? { yieldedFinalDeliverable: true } : {}),
    ...(source?.rearmGeneration !== undefined ? { rearmGeneration: source.rearmGeneration } : {}),
  };
}

/** Cancellation closes a wave only after its current task ownership is considered. */
export function isRequesterSettleDeliveryClosed(params: {
  requesterRun: SubagentRunRecord | null | undefined;
  currentRequester: SubagentRunRecord | null | undefined;
  currentRuns: readonly SubagentRunRecord[];
  batch: readonly SubagentRunRecord[];
  requesterYieldBatch: boolean;
}): boolean {
  const { requesterRun, currentRequester, currentRuns } = params;
  const currentBatch = params.batch.map(
    (entry) => currentRuns.find((current) => isSameSubagentRunOwner(current, entry)) ?? entry,
  );
  return (
    requesterRun?.killReconciliation?.suppressTaskDelivery === true ||
    requesterRun?.suppressCompletionDelivery === true ||
    currentRequester?.killReconciliation?.suppressTaskDelivery === true ||
    currentRequester?.suppressCompletionDelivery === true ||
    // A yielded cohort reports the members it still holds; requester-wide cancellation
    // already removed its own. An ordinary wave owes nothing once every member retired.
    (!params.requesterYieldBatch && currentBatch.every(isSubagentObligationRetired))
  );
}

export function captureRequesterRunOwner(requesterRun: SubagentRunRecord | null | undefined) {
  const requesterTaskRunId = requesterRun?.taskRunId ?? requesterRun?.runId;
  return (currentRequester: SubagentRunRecord | null | undefined, continuationRunId: string) => {
    if (!currentRequester || !requesterRun) {
      return !currentRequester && !requesterRun;
    }
    if (isSameSubagentRun(currentRequester, requesterRun)) {
      return isSameSubagentRunOwner(currentRequester, requesterRun);
    }
    // Only the admitted continuation may replace its captured task owner.
    return (
      currentRequester.runId === continuationRunId &&
      currentRequester.taskRunId === requesterTaskRunId &&
      currentRequester.requesterSessionKey === requesterRun.requesterSessionKey &&
      currentRequester.requesterAgentId === requesterRun.requesterAgentId
    );
  };
}

/**
 * A yield hands continuation back to the requester, so its own final may reach the
 * conversation under its normal reply rules; private findings stay wake input. The
 * policy is fixed when the yield writes the batch: a batch without the marker came
 * from an earlier build and stays private, so an upgrade cannot republish its input.
 */
export function resolveRequesterSettlePolicy(
  completionRows: readonly SubagentRunRecord[],
  requesterYielded: boolean,
  state: RequesterSettleWakeBatchState,
  requester: { sessionId: string; lifecycleRevision?: string },
  completionRowsMatchRequester: boolean,
) {
  // One private result makes the aggregate private; public siblings keep their own route.
  const privateRows = completionRows.filter((entry) => entry.completionTarget === "parent");
  const hasPrivateRows = privateRows.length > 0;
  const yieldedFinalDeliverable =
    hasPrivateRows && requesterYielded && state.yieldedFinalDeliverable === true;
  const parentOnly = hasPrivateRows && !yieldedFinalDeliverable;
  // Retained public history keeps its existing admission; it cannot mint a new
  // own-session alternative from a later reread of the requester key.
  const bindRequester =
    hasPrivateRows || (completionRows.length > 0 && completionRowsMatchRequester);
  const requesterBinding = {
    ...(parentOnly ? { completionTarget: "parent" as const } : {}),
    ...(bindRequester
      ? {
          completionRequesterSessionId: requester.sessionId,
          completionRequesterLifecycleRevision: requester.lifecycleRevision,
        }
      : {}),
  };
  const admissionMarker = yieldedFinalDeliverable ? { yieldedFinalDeliverable: true as const } : {};
  // A yield owes the conversation a visible final unless private findings let the
  // requester choose silence.
  const requireVisibleReply = requesterYielded && !hasPrivateRows;
  return { privateRows, requireVisibleReply, parentOnly, requesterBinding, admissionMarker };
}
