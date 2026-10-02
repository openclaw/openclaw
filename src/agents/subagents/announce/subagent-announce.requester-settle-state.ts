import type {
  RequesterSettleWakeState,
  SubagentRunRecord,
} from "../registry/subagent-registry.types.js";
import type { SubagentAnnounceDeliveryResult } from "./subagent-announce-dispatch.js";

export type RequesterSettleWakeBatchState = Omit<RequesterSettleWakeState, "retireAfterSettle">;

export type RequesterSettleWakeBatchCallbacks = {
  transitionBatch: (
    batch: readonly SubagentRunRecord[],
    state: RequesterSettleWakeBatchState,
  ) => void | Promise<void>;
  completeBatch: (
    batch: readonly SubagentRunRecord[],
    rearmGeneration?: number,
    delivery?: SubagentAnnounceDeliveryResult,
    onCommitted?: () => void,
  ) => void | Promise<void>;
};

const activeRequesterSettleWakeBatches = new Map<string, () => boolean>();

/** Reads stay independent; the first prepared decision owns mutation and delivery. */
export function createRequesterSettleBatchClaim(
  key: string,
  isGatewayCurrent: (() => boolean) | undefined,
) {
  const hadGatewayContext = isGatewayCurrent?.() === true;
  if (isGatewayCurrent && !hadGatewayContext) {
    return undefined;
  }
  const isGatewayClosed = () => {
    try {
      return hadGatewayContext && !isGatewayCurrent?.();
    } catch {
      // An incompatible captured batch cannot block a fresh Gateway owner.
      return hadGatewayContext;
    }
  };
  return {
    isGatewayClosed,
    claim: (): boolean => {
      const owner = activeRequesterSettleWakeBatches.get(key);
      if (owner === isGatewayClosed) {
        return true;
      }
      if (owner?.() === false) {
        return false;
      }
      activeRequesterSettleWakeBatches.set(key, isGatewayClosed);
      return true;
    },
    release(): void {
      if (activeRequesterSettleWakeBatches.get(key) === isGatewayClosed) {
        activeRequesterSettleWakeBatches.delete(key);
      }
    },
  };
}

/** Fence consumed pause notices and completions superseded by a pause. */
export function isRequesterWakeStateCurrent(
  entry: SubagentRunRecord,
  rearmGeneration: number | undefined,
  pause: boolean,
): boolean {
  const wake = entry.requesterSettleWake;
  return Boolean(
    wake &&
    wake.rearmGeneration === rearmGeneration &&
    (pause
      ? entry.pauseReason === "sessions_yield" && wake.pauseNotice
      : entry.pauseReason !== "sessions_yield"),
  );
}

export function retainedYieldIdentity(state: RequesterSettleWakeBatchState) {
  return {
    ...(state.pauseNotice ? { pauseNotice: state.pauseNotice } : {}),
    ...(state.requesterYieldBatch === true ? { requesterYieldBatch: true as const } : {}),
    ...(state.afterRequesterYield === true ? { afterRequesterYield: true as const } : {}),
    ...(state.yieldedFinalDeliverable === true ? { yieldedFinalDeliverable: true as const } : {}),
    ...(state.rearmGeneration !== undefined ? { rearmGeneration: state.rearmGeneration } : {}),
  };
}

export function readSharedBatchState(
  batch: readonly SubagentRunRecord[],
): RequesterSettleWakeBatchState {
  const states = batch
    .map((entry) => entry.requesterSettleWake)
    .filter((state): state is RequesterSettleWakeState => Boolean(state));
  const dispatching = states.find((state) => state.status === "dispatching");
  const source = dispatching ?? states[0];
  return {
    status: source?.status ?? "pending",
    ...(source?.pauseNotice ? { pauseNotice: source.pauseNotice } : {}),
    attemptCount: Math.max(0, ...states.map((state) => state.attemptCount)),
    ...(source?.replayCount !== undefined ? { replayCount: source.replayCount } : {}),
    ...(source?.nextAttemptAt !== undefined ? { nextAttemptAt: source.nextAttemptAt } : {}),
    ...(source?.batchRunIds ? { batchRunIds: [...source.batchRunIds] } : {}),
    ...(states.some((state) => state.requesterYieldBatch === true)
      ? { requesterYieldBatch: true }
      : {}),
    ...(states.some((state) => state.afterRequesterYield === true)
      ? { afterRequesterYield: true }
      : {}),
    ...(source?.yieldedFinalDeliverable === true ? { yieldedFinalDeliverable: true } : {}),
    ...(source?.rearmGeneration !== undefined ? { rearmGeneration: source.rearmGeneration } : {}),
    ...(source?.lastError !== undefined ? { lastError: source.lastError } : {}),
    deferralCount: Math.max(0, ...states.map((state) => state.deferralCount ?? 0)),
  };
}

export function captureRequesterRunOwner(requesterRun: SubagentRunRecord | null | undefined) {
  const requesterGeneration = requesterRun?.generation;
  const requesterCreatedAt = requesterRun?.createdAt;
  const requesterTaskRunId = requesterRun?.taskRunId ?? requesterRun?.runId;
  return (currentRequester: SubagentRunRecord | null | undefined, continuationRunId: string) => {
    // Normal admission adopts a paused requester before execution starts.
    // Only this admitted continuation may replace its captured task owner.
    if (
      (currentRequester !== requesterRun ||
        currentRequester?.generation !== requesterGeneration ||
        currentRequester?.createdAt !== requesterCreatedAt) &&
      (!requesterRun ||
        !currentRequester ||
        currentRequester.runId !== continuationRunId ||
        currentRequester.taskRunId !== requesterTaskRunId ||
        currentRequester.requesterSessionKey !== requesterRun.requesterSessionKey ||
        currentRequester.requesterAgentId !== requesterRun.requesterAgentId)
    ) {
      return false;
    }
    return true;
  };
}

/**
 * A yield hands continuation back to the requester, so its own final may reach the
 * conversation under its normal reply rules; private findings stay wake input. The
 * policy is fixed when the yield writes the batch: a batch without the marker came
 * from an earlier build and stays private, so an upgrade cannot republish its input.
 */
export function resolvePrivateSettlePolicy(
  completionRows: readonly SubagentRunRecord[],
  requesterYielded: boolean,
  state: RequesterSettleWakeBatchState,
  requester: { sessionId: string; lifecycleRevision?: string },
) {
  // One private result makes the aggregate private; public siblings keep their own route.
  const privateRows = completionRows.filter((entry) => entry.completionTarget === "parent");
  const hasPrivateRows = privateRows.length > 0;
  const yieldedFinalDeliverable =
    hasPrivateRows && requesterYielded && state.yieldedFinalDeliverable === true;
  const parentOnly = hasPrivateRows && !yieldedFinalDeliverable;
  // Private findings stay bound to the requester incarnation that produced them.
  const privateBinding = {
    ...(parentOnly ? { completionTarget: "parent" as const } : {}),
    ...(hasPrivateRows
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
  return { privateRows, requireVisibleReply, parentOnly, privateBinding, admissionMarker };
}
