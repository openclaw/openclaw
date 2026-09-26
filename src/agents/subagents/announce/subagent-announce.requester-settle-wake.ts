/**
 * Durable requester settle wake delivery.
 *
 * Lifecycle owns the persisted outbox state on retained subagent run rows;
 * this module selects a drained wave and delivers its synthesized wake.
 */
import { getRuntimeConfig } from "../../../config/config.js";
import { isSystemEventStoreCurrent } from "../../../infra/system-event-ownership.js";
import { logWarn } from "../../../logger.js";
import { getSharedGatewayContextResolver } from "../../../plugins/runtime/gateway-request-scope.js";
import { isCronSessionKey } from "../../../sessions/session-key-utils.js";
import { withTaskProgressRequesterContinuation } from "../../../tasks/task-progress-requester.js";
import {
  type DeliveryContext,
  normalizeDeliveryContext,
} from "../../../utils/delivery-context.shared.js";
import {
  isDeliverableMessageChannel,
  normalizeMessageChannel,
} from "../../../utils/message-channel.js";
import { resolveSubagentRequesterAgentId } from "../../subagent-requester-owner.js";
import {
  getFollowupForCohort,
  withFollowupSuccessor,
} from "../completion/session-followup-completion.js";
import { subagentRuns } from "../registry/subagent-registry-memory.js";
import { selectConnectedSettledSubagentWave } from "../registry/subagent-registry-queries.js";
import {
  countActiveDescendantRuns,
  getLatestLiveSubagentRunByChildSessionKey,
  getLatestSubagentRunByChildSessionKey,
  hasDescendantRunAwaitingSettle,
  listSubagentRunsForRequester,
} from "../registry/subagent-registry-read.js";
import type {
  RequesterSettleWakeState,
  SubagentRunRecord,
} from "../registry/subagent-registry.types.js";
import { buildRequesterSettleWakeIdentity } from "../registry/subagent-requester-settle-identity.js";
import { hasSubagentRunEnded } from "../registry/subagent-run-liveness.js";
import { withRequesterCronAuthority } from "../requester-cron-authority.js";
import {
  consumeRequesterFinalAttachment,
  revokeRequesterFinalAttachment,
  transferRequesterFinalAttachment,
} from "../requester-final-attachment.js";
import { getSubagentDepthFromSessionStore } from "../spawn/subagent-depth.js";
import { isPermanentAnnounceDeliveryError } from "./subagent-announce-delivery-retry.js";
import {
  deliverSubagentAnnouncement,
  loadRequesterSessionEntry,
} from "./subagent-announce-delivery.js";
import type { SubagentAnnounceDeliveryResult } from "./subagent-announce-dispatch.js";
import { resolveAnnounceOrigin } from "./subagent-announce-origin.js";
import {
  readChildCompletionFindings,
  dedupeLatestChildCompletionRows,
  filterCurrentDirectChildCompletionRows,
} from "./subagent-announce-output.js";
import { hasUsableSessionEntry } from "./subagent-announce.js";
import { buildRequesterSettleWakeMessage } from "./subagent-announce.requester-settle-message.js";

export type RequesterSettleWakeBatchState = Omit<RequesterSettleWakeState, "retireAfterSettle">;

type RequesterSettleWakeBatchCallbacks = {
  transitionBatch: (
    batch: readonly SubagentRunRecord[],
    state: RequesterSettleWakeBatchState,
  ) => void;
  completeBatch: (
    batch: readonly SubagentRunRecord[],
    rearmGeneration?: number,
    delivery?: SubagentAnnounceDeliveryResult,
    onCommitted?: () => void,
  ) => void;
};

const REQUESTER_SETTLE_WAKE_MAX_ATTEMPTS = 3;
const REQUESTER_SETTLE_WAKE_MAX_AMBIGUOUS_REPLAYS = 3;
const REQUESTER_SETTLE_WAKE_MAX_DEFERRALS = 10;
const REQUESTER_SETTLE_WAKE_RETRY_DELAYS_MS = [30_000, 120_000] as const;
const activeRequesterSettleWakeBatches = new Map<string, () => boolean>();

function readSharedBatchState(batch: readonly SubagentRunRecord[]): RequesterSettleWakeBatchState {
  const states = batch
    .map((entry) => entry.requesterSettleWake)
    .filter((state): state is RequesterSettleWakeState => Boolean(state));
  const dispatching = states.find((state) => state.status === "dispatching");
  const source = dispatching ?? states[0];
  return {
    status: source?.status ?? "pending",
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
    ...(source?.rearmGeneration !== undefined ? { rearmGeneration: source.rearmGeneration } : {}),
    ...(source?.lastError !== undefined ? { lastError: source.lastError } : {}),
    deferralCount: Math.max(0, ...states.map((state) => state.deferralCount ?? 0)),
  };
}

/**
 * Wakes a top-level or explicitly yielded nested requester once its batch's last
 * child and descendants settle. Durable state transitions happen synchronously
 * through lifecycle-owned callbacks before and after every async delivery.
 */
export async function maybeWakeRequesterAfterAllChildrenSettled(
  params: RequesterSettleWakeBatchCallbacks & {
    requesterSessionKey: string;
    requesterOrigin?: DeliveryContext;
    settledEntry: SubagentRunRecord;
    signal?: AbortSignal;
  },
): Promise<boolean> {
  if (params.signal?.aborted) {
    return false;
  }
  const requesterSessionKey = params.requesterSessionKey.trim();
  const cfg = getRuntimeConfig();
  const requesterAgentId = resolveSubagentRequesterAgentId(cfg, params.settledEntry);
  const requesterStorePath = params.settledEntry.requesterStorePath ?? null;
  const initialState = params.settledEntry.requesterSettleWake;
  if (!requesterSessionKey || !initialState) {
    return false;
  }
  const finalizeRequesterAttachment = (
    runIds: readonly string[],
    state: RequesterSettleWakeBatchState,
    delivery?: SubagentAnnounceDeliveryResult,
    requesterSessionId?: string,
  ): void => {
    if (
      !requesterAgentId ||
      state.requesterYieldBatch !== true ||
      state.rearmGeneration === undefined
    ) {
      return;
    }
    const finalText = delivery?.finalAssistantVisibleText?.trim();
    if (delivery?.delivered && requesterSessionId && finalText) {
      consumeRequesterFinalAttachment({
        requesterAgentId,
        requesterSessionKey,
        requesterSessionId,
        batchRunIds: runIds,
        rearmGeneration: state.rearmGeneration,
        text: finalText,
      });
      return;
    }
    revokeRequesterFinalAttachment({
      requesterAgentId,
      requesterSessionKey,
      batchRunIds: runIds,
      rearmGeneration: state.rearmGeneration,
    });
  };
  const completeBatch = (
    batch: readonly SubagentRunRecord[],
    state: RequesterSettleWakeBatchState,
    delivery?: SubagentAnnounceDeliveryResult,
    requesterSessionId?: string,
  ): void =>
    params.completeBatch(batch, state.rearmGeneration, delivery, () =>
      finalizeRequesterAttachment(
        batch.map((entry) => entry.runId).toSorted(),
        state,
        delivery,
        requesterSessionId,
      ),
    );
  const admittedRearmGeneration = initialState.rearmGeneration;
  if (isCronSessionKey(requesterSessionKey)) {
    completeBatch([params.settledEntry], initialState);
    return false;
  }

  const requesterRuns = listSubagentRunsForRequester(requesterSessionKey, {
    requesterAgentId,
    requesterStorePath,
  });
  const currentSettledEntry = requesterRuns.find(
    (entry) => entry.runId === params.settledEntry.runId,
  );
  const currentState = currentSettledEntry?.requesterSettleWake;
  // A requester yield may re-arm this row while runtime loading is in flight.
  // Only the admitted generation may inspect descendants or mutate its batch.
  if (
    currentSettledEntry !== params.settledEntry ||
    !currentState ||
    currentState.rearmGeneration !== admittedRearmGeneration
  ) {
    return false;
  }
  const frozenBatchRunIds = currentState.batchRunIds;
  const currentRearmGeneration = currentState.rearmGeneration;
  let settledBatch: SubagentRunRecord[];
  if (frozenBatchRunIds && frozenBatchRunIds.length > 0) {
    const runsById = new Map(requesterRuns.map((entry) => [entry.runId, entry]));
    // Retired rows no longer own completion, but every surviving frozen member
    // must be terminal before this batch can wake its requester.
    settledBatch = frozenBatchRunIds
      .map((runId) => runsById.get(runId))
      .filter(
        (entry): entry is SubagentRunRecord =>
          Boolean(entry?.requesterSettleWake) &&
          entry?.requesterSettleWake?.rearmGeneration === currentRearmGeneration,
      );
    if (
      settledBatch.some(
        (entry) => entry.execution.status === "running" || !hasSubagentRunEnded(entry),
      )
    ) {
      return false;
    }
  } else {
    // An unfrozen wave cannot absorb a different requester-yield generation.
    // Its frozen cohort still owns its deadline, retry budget, and visible final.
    settledBatch = selectConnectedSettledSubagentWave(
      requesterRuns.filter(
        (entry) =>
          entry.requesterSettleWake &&
          entry.requesterSettleWake.rearmGeneration === currentRearmGeneration &&
          entry.execution.status !== "running" &&
          hasSubagentRunEnded(entry),
      ),
      currentSettledEntry,
    );
  }
  if (settledBatch.length === 0) {
    return false;
  }

  // Scheduling is per child, but every replay of this frozen wave is one input.
  // Retain all possible shipped sources only for exact accepted-input matching.
  const batchSessionKeys = [...new Set(settledBatch.map((run) => run.childSessionKey))].toSorted();
  const batchCreatedAt = Math.min(...settledBatch.map((entry) => entry.createdAt));
  // Keep the batch members themselves in the settle check, including paused work.
  const rootRunIds = frozenBatchRunIds?.length ? new Set(frozenBatchRunIds) : undefined;
  const requesterHasUnsettledDescendants = () =>
    hasDescendantRunAwaitingSettle(
      requesterSessionKey,
      currentSettledEntry.runId,
      requesterAgentId,
      requesterStorePath,
      batchCreatedAt,
      rootRunIds,
    );
  const hasUnsettledDescendants = requesterHasUnsettledDescendants();
  if ((!frozenBatchRunIds || frozenBatchRunIds.length === 0) && hasUnsettledDescendants) {
    return false;
  }

  const resolveGatewayContext = getSharedGatewayContextResolver(settledBatch);
  const hadGatewayContext = Boolean(resolveGatewayContext?.());
  // Runtime loading may outlive the Gateway. Unavailable ownership spends no delivery budget.
  if (resolveGatewayContext && !hadGatewayContext) {
    return false;
  }
  const batchRunIds = settledBatch.map((entry) => entry.runId).toSorted();
  const selectedState = readSharedBatchState(settledBatch);
  const isStoreCurrent = () =>
    settledBatch.every((entry) =>
      isSystemEventStoreCurrent(requesterSessionKey, entry.requesterStorePath, requesterAgentId),
    );
  const retireReplacedStore = () => {
    if (isStoreCurrent()) {
      return false;
    }
    completeBatch(settledBatch, selectedState, {
      delivered: false,
      path: "none",
      error: "store replaced",
      storeReplaced: true,
      disposition: "intentional_non_delivery",
    });
    return true;
  };
  if (retireReplacedStore()) {
    return false;
  }
  const followup = getFollowupForCohort(settledBatch);
  const getRequesterRun = () =>
    followup
      ? undefined
      : (getLatestLiveSubagentRunByChildSessionKey(
          requesterSessionKey,
          (entry) => entry.pauseReason === "sessions_yield",
        ) ?? getLatestLiveSubagentRunByChildSessionKey(requesterSessionKey));
  const requesterRun = getRequesterRun();
  const requesterGeneration = requesterRun?.generation;
  const requesterCreatedAt = requesterRun?.createdAt;
  const requesterTaskRunId = requesterRun?.taskRunId ?? requesterRun?.runId;
  const isBatchDeliveryClosed = () => {
    const currentRequester = getRequesterRun();
    return (
      requesterRun?.killReconciliation?.suppressTaskDelivery === true ||
      requesterRun?.suppressCompletionDelivery === true ||
      currentRequester?.killReconciliation?.suppressTaskDelivery === true ||
      currentRequester?.suppressCompletionDelivery === true ||
      // This marker is written by requester-wide abort/reset, so even a
      // completed sibling cannot keep the old frozen obligation alive.
      settledBatch.some((entry) => entry.killReconciliation?.suppressTaskDelivery === true) ||
      settledBatch.every((entry) => entry.suppressCompletionDelivery === true)
    );
  };
  if (isBatchDeliveryClosed()) {
    // Cancellation already owns the task result; only consume its obsolete wake.
    completeBatch(settledBatch, selectedState);
    return false;
  }
  function deferBatch(
    state: RequesterSettleWakeBatchState,
    countTowardsLimit = countActiveDescendantRuns(
      requesterSessionKey,
      requesterAgentId,
      requesterStorePath,
      rootRunIds,
    ) === 0,
  ): void {
    const now = Date.now();
    if ((state.nextAttemptAt ?? 0) > now) {
      return;
    }
    // Live descendant or requester work is not a stale settle loop.
    // Reset their stale-deferral budget so long-running waves cannot terminalize
    // an already completed sibling before the requester can receive it.
    const deferralCount = countTowardsLimit ? (state.deferralCount ?? 0) + 1 : 0;
    if (countTowardsLimit && deferralCount >= REQUESTER_SETTLE_WAKE_MAX_DEFERRALS) {
      completeBatch(settledBatch, state, {
        delivered: false,
        path: "none",
        error: "requester settle wake deferred too many times",
      });
      return;
    }
    params.transitionBatch(settledBatch, {
      status: state.status,
      attemptCount: state.attemptCount,
      ...(state.replayCount !== undefined ? { replayCount: state.replayCount } : {}),
      nextAttemptAt: Math.max(
        state.nextAttemptAt ?? 0,
        now + REQUESTER_SETTLE_WAKE_RETRY_DELAYS_MS[0],
      ),
      batchRunIds: [...batchRunIds],
      ...(state.requesterYieldBatch === true ? { requesterYieldBatch: true } : {}),
      ...(state.afterRequesterYield === true ? { afterRequesterYield: true } : {}),
      ...(state.rearmGeneration !== undefined ? { rearmGeneration: state.rearmGeneration } : {}),
      ...(state.lastError !== undefined ? { lastError: state.lastError } : {}),
      deferralCount,
    });
  }
  if (hasUnsettledDescendants) {
    if (frozenBatchRunIds && frozenBatchRunIds.length > 0) {
      deferBatch(selectedState);
    }
    return false;
  }
  const requiredSettled = settledBatch.filter((entry) => entry.expectsCompletionMessage === true);
  const hasUndeliveredRequiredCompletion = requiredSettled.some(
    (entry) => entry.delivery?.status !== "delivered",
  );
  // A yielded batch owns a rearm generation even when its child settles later.
  // Otherwise a delivered single child clears the batch before its requester wakes.
  const requesterYieldedAfterDelivery =
    selectedState.afterRequesterYield === true ||
    (selectedState.requesterYieldBatch === true && selectedState.rearmGeneration !== undefined);
  const requesterDepth = getSubagentDepthFromSessionStore(requesterSessionKey, {
    cfg,
    agentId: requesterAgentId,
  });
  // Explicit yield transfers continuation to this batch at every depth.
  // Ordinary nested waves remain owned by the descendant-settle path.
  if (
    requiredSettled.length === 0 ||
    (requiredSettled.length < 2 &&
      !hasUndeliveredRequiredCompletion &&
      !requesterYieldedAfterDelivery) ||
    (!requesterYieldedAfterDelivery && requesterDepth >= 1)
  ) {
    completeBatch(settledBatch, selectedState);
    return false;
  }

  const { entry: requesterEntry } = loadRequesterSessionEntry(
    requesterSessionKey,
    requesterAgentId,
  );
  if (!hasUsableSessionEntry(requesterEntry)) {
    completeBatch(settledBatch, selectedState, {
      delivered: false,
      path: "none",
      error: "requester session unavailable",
    });
    return false;
  }

  const completionRows = dedupeLatestChildCompletionRows(
    filterCurrentDirectChildCompletionRows(settledBatch, {
      requesterSessionKey,
      requesterAgentId,
      getLatestSubagentRunByChildSessionKey,
    }),
  );
  // Delivered children remain in yield cohorts. One private result makes the
  // aggregate private; public siblings keep their individual completion route.
  const privateRows = completionRows.filter((entry) => entry.completionTarget === "parent");
  const parentOnly = privateRows.length > 0;
  if (
    privateRows.some((entry) => entry.completionRequesterSessionId !== requesterEntry.sessionId)
  ) {
    completeBatch(settledBatch, selectedState, {
      delivered: false,
      path: "none",
      reason: "completion_handoff_unavailable",
      error: "private completion requester session was replaced",
      terminal: true,
      disposition: "intentional_non_delivery",
    });
    return false;
  }
  const preparedFindings = await readChildCompletionFindings(completionRows);
  if (retireReplacedStore()) {
    return false;
  }
  const requesterSessionOrigin = normalizeDeliveryContext(params.requesterOrigin);
  const directOrigin = resolveAnnounceOrigin(requesterEntry, requesterSessionOrigin);
  const completionChannel = normalizeMessageChannel(directOrigin?.channel);
  const wakeMessage = buildRequesterSettleWakeMessage({
    findings: preparedFindings.text,
    requireVisibleReply: requesterYieldedAfterDelivery,
    parentOnly,
    children: completionRows,
    preserveModelRouteNotice: !completionChannel || !isDeliverableMessageChannel(completionChannel),
  });
  const { batchKey: wakeKeyBase } = buildRequesterSettleWakeIdentity({
    requesterSessionKey,
    requesterAgentId,
    batchRunIds,
    rearmGeneration: selectedState.rearmGeneration,
  });
  if (activeRequesterSettleWakeBatches.get(wakeKeyBase)?.() === false) {
    return false;
  }
  // A matching key or fresh row cannot supersede live or unproven authority.
  const isGatewayClosed = () => {
    try {
      return hadGatewayContext && !resolveGatewayContext?.();
    } catch {
      // An incompatible captured batch cannot keep a fresh owner's claim blocked.
      return hadGatewayContext;
    }
  };
  activeRequesterSettleWakeBatches.set(wakeKeyBase, isGatewayClosed);

  try {
    if (params.signal?.aborted) {
      return false;
    }
    let state = readSharedBatchState(settledBatch);
    if (!settledBatch.some((entry) => entry.requesterSettleWake)) {
      return false;
    }
    if ((state.nextAttemptAt ?? 0) > Date.now()) {
      // Lifecycle owns the durable deadline timer and re-admits root work.
      // Returning here keeps restart/suspend drains free during backoff.
      return false;
    }
    // Recheck owned descendants after loading findings and before dispatch.
    if (requesterHasUnsettledDescendants()) {
      deferBatch(state);
      return false;
    }

    // A restart or an ambiguous delivery can leave a row at the cap in
    // "dispatching". That state must exhaust like any other, or the batch
    // replays one attempt key forever without ever completing.
    if (state.attemptCount >= REQUESTER_SETTLE_WAKE_MAX_ATTEMPTS) {
      completeBatch(settledBatch, state, {
        delivered: false,
        path: "none",
        error: state.lastError ?? "requester settle wake attempts exhausted",
      });
      return false;
    }

    let attemptIndex: number;
    if (state.status === "dispatching") {
      // Ambiguous delivery reuses its attempt key. Completed-turn RPC replay
      // is Gateway-local; the key alone is not a cross-restart delivery receipt.
      attemptIndex = Math.max(0, state.attemptCount - 1);
    } else {
      attemptIndex = state.attemptCount;
      state = {
        status: "dispatching",
        attemptCount: state.attemptCount + 1,
        batchRunIds,
        ...(state.requesterYieldBatch === true ? { requesterYieldBatch: true } : {}),
        ...(state.afterRequesterYield === true ? { afterRequesterYield: true } : {}),
        ...(state.rearmGeneration !== undefined ? { rearmGeneration: state.rearmGeneration } : {}),
      };
      params.transitionBatch(settledBatch, state);
    }

    const { runId: directIdempotencyKey } = buildRequesterSettleWakeIdentity({
      requesterSessionKey,
      requesterAgentId,
      batchRunIds,
      rearmGeneration: selectedState.rearmGeneration,
      attemptIndex,
      parentOnly,
    });
    const requesterSessionId = requesterEntry.sessionId;
    const requesterLifecycleRevision = requesterEntry.lifecycleRevision;
    const isRequesterCurrent = () => {
      if (followup) {
        try {
          followup.assertCurrent();
          return true;
        } catch {
          return false;
        }
      }
      const currentRequester = getRequesterRun();
      // Normal admission adopts a paused requester before execution starts.
      // Only this admitted continuation may replace its captured task owner.
      if (
        (currentRequester !== requesterRun ||
          currentRequester?.generation !== requesterGeneration ||
          currentRequester?.createdAt !== requesterCreatedAt) &&
        (!requesterRun ||
          !currentRequester ||
          currentRequester.runId !== directIdempotencyKey ||
          currentRequester.taskRunId !== requesterTaskRunId ||
          currentRequester.requesterSessionKey !== requesterRun.requesterSessionKey ||
          currentRequester.requesterAgentId !== requesterRun.requesterAgentId)
      ) {
        return false;
      }
      const currentSession = loadRequesterSessionEntry(requesterSessionKey, requesterAgentId).entry;
      return (
        currentSession?.sessionId === requesterSessionId &&
        currentSession?.lifecycleRevision === requesterLifecycleRevision
      );
    };
    const isBatchCurrent = () => {
      const currentRuns = filterCurrentDirectChildCompletionRows(
        listSubagentRunsForRequester(requesterSessionKey, { requesterAgentId, requesterStorePath }),
        {
          requesterSessionKey,
          requesterAgentId,
          getLatestSubagentRunByChildSessionKey,
        },
      );
      return settledBatch.every(
        (entry) =>
          currentRuns.includes(entry) &&
          entry.requesterSettleWake !== undefined &&
          entry.requesterSettleWake.rearmGeneration === currentRearmGeneration,
      );
    };
    const isSourceSessionEffectsAllowed = () =>
      !params.signal?.aborted &&
      isStoreCurrent() &&
      preparedFindings.isCurrent() &&
      !isGatewayClosed() &&
      isBatchCurrent() &&
      isRequesterCurrent() &&
      !isBatchDeliveryClosed();
    const settleRevokedBatch = (): boolean => {
      if (isGatewayClosed() || !isBatchCurrent() || retireReplacedStore()) {
        return true;
      }
      if (isBatchDeliveryClosed() || !isRequesterCurrent()) {
        completeBatch(settledBatch, state);
        return true;
      }
      return false;
    };
    if (requesterAgentId && state.requesterYieldBatch && state.rearmGeneration !== undefined) {
      transferRequesterFinalAttachment({
        requesterAgentId,
        requesterSessionKey,
        requesterSessionId: requesterEntry.sessionId,
        batchRunIds,
        rearmGeneration: state.rearmGeneration,
        requesterTurnRunId: directIdempotencyKey,
      });
    }
    let delivery: Awaited<ReturnType<typeof deliverSubagentAnnouncement>>;
    try {
      const dispatch = () =>
        subagentRuns.runWithCompletionBatchAuthority(settledBatch, () =>
          withTaskProgressRequesterContinuation(
            {
              entries: settledBatch,
              runId: directIdempotencyKey,
              requesterSessionId: requesterEntry.sessionId,
              isCurrent: isSourceSessionEffectsAllowed,
            },
            () =>
              withRequesterCronAuthority(
                {
                  requesterSessionKey,
                  requesterSessionId,
                  requesterAgentId,
                  batch: settledBatch,
                  rearmGeneration: state.requesterYieldBatch ? state.rearmGeneration : undefined,
                  runId: directIdempotencyKey,
                  isCurrent: isSourceSessionEffectsAllowed,
                },
                () =>
                  deliverSubagentAnnouncement({
                    requesterSessionKey,
                    requesterAgentId,
                    requesterRunTimeoutSeconds:
                      requesterDepth >= 1 && requesterRun
                        ? (requesterRun.runTimeoutSeconds ?? 0)
                        : undefined,
                    triggerMessage: wakeMessage,
                    steerMessage: wakeMessage,
                    requesterSessionOrigin,
                    directOrigin,
                    sourceSessionKey: batchSessionKeys[0],
                    settleWakeSourceSessionKeys: batchSessionKeys,
                    sourceTool: "subagent_settle",
                    targetRequesterSessionKey: requesterSessionKey,
                    requesterIsSubagent: requesterDepth >= 1,
                    expectsCompletionMessage: false,
                    requireDirectDelivery: true,
                    ...(parentOnly
                      ? {
                          completionTarget: "parent",
                          completionRequesterSessionId: requesterEntry.sessionId,
                        }
                      : {}),
                    ...(!parentOnly && requesterYieldedAfterDelivery
                      ? { requireVisibleReply: true }
                      : {}),
                    directIdempotencyKey,
                    signal: params.signal,
                    resolveGatewayContext,
                    isSourceSessionEffectsAllowed,
                  }),
              ),
          ),
        );
      delivery = followup
        ? await withFollowupSuccessor(
            followup.successor(settledBatch, directIdempotencyKey, () => {
              if (!isSourceSessionEffectsAllowed()) {
                throw new Error("Followup completion cohort changed.");
              }
            }),
            dispatch,
          )
        : await dispatch();
    } catch (error) {
      if (settleRevokedBatch()) {
        return false;
      }
      const lastError = error instanceof Error ? error.message : String(error);
      if (isPermanentAnnounceDeliveryError(error)) {
        completeBatch(settledBatch, state, {
          delivered: false,
          path: "none",
          disposition: "permanent_failure",
          error: lastError,
        });
        return false;
      }
      // A transport exception can arrive after gateway admission. Replay the
      // same persisted idempotency key; only a known no-turn result may rotate it.
      const replayCount = (state.replayCount ?? 0) + 1;
      const retryDelayMs = REQUESTER_SETTLE_WAKE_RETRY_DELAYS_MS[replayCount - 1];
      if (
        replayCount >= REQUESTER_SETTLE_WAKE_MAX_AMBIGUOUS_REPLAYS ||
        retryDelayMs === undefined
      ) {
        completeBatch(settledBatch, state, {
          delivered: false,
          path: "none",
          error: lastError,
        });
        return false;
      }
      state = {
        status: "dispatching",
        attemptCount: state.attemptCount,
        replayCount,
        nextAttemptAt: Date.now() + retryDelayMs,
        batchRunIds,
        ...(state.requesterYieldBatch === true ? { requesterYieldBatch: true } : {}),
        ...(state.afterRequesterYield === true ? { afterRequesterYield: true } : {}),
        ...(state.rearmGeneration !== undefined ? { rearmGeneration: state.rearmGeneration } : {}),
        lastError,
      };
      params.transitionBatch(settledBatch, state);
      logWarn(
        `requester settle wake transport replay ${replayCount} scheduled in ${Math.round(retryDelayMs / 1000)}s: ${lastError}`,
      );
      return false;
    }
    if (delivery.delivered) {
      completeBatch(settledBatch, state, delivery, requesterEntry.sessionId);
      return true;
    }
    if (settleRevokedBatch()) {
      return false;
    }
    if (delivery.reason === "requester_turn_pending") {
      // An existing Gateway turn still owns the input. Observe the same request
      // without spending failure attempts or closing its completion obligation.
      deferBatch({ ...state, lastError: undefined }, false);
      return false;
    }
    if (
      delivery.disposition === "ambiguous" ||
      delivery.disposition === "permanent_failure" ||
      delivery.disposition === "intentional_non_delivery" ||
      delivery.reason === "requester_abandoned"
    ) {
      completeBatch(settledBatch, state, delivery, requesterEntry.sessionId);
      return false;
    }

    const attemptCount = attemptIndex + 1;
    const retryDelayMs = REQUESTER_SETTLE_WAKE_RETRY_DELAYS_MS[attemptIndex];
    const lastError = delivery.error ?? delivery.reason ?? "undelivered";
    if (attemptCount >= REQUESTER_SETTLE_WAKE_MAX_ATTEMPTS || retryDelayMs === undefined) {
      completeBatch(
        settledBatch,
        state,
        { ...delivery, error: lastError },
        requesterEntry.sessionId,
      );
      return false;
    }
    params.transitionBatch(settledBatch, {
      status: "pending",
      attemptCount,
      nextAttemptAt: Date.now() + retryDelayMs,
      batchRunIds,
      ...(state.requesterYieldBatch === true ? { requesterYieldBatch: true } : {}),
      ...(state.afterRequesterYield === true ? { afterRequesterYield: true } : {}),
      ...(state.rearmGeneration !== undefined ? { rearmGeneration: state.rearmGeneration } : {}),
      lastError,
    });
    logWarn(
      `requester settle wake attempt ${attemptCount} failed; retrying in ${Math.round(retryDelayMs / 1000)}s: ${lastError}`,
    );
    return false;
  } finally {
    if (activeRequesterSettleWakeBatches.get(wakeKeyBase) === isGatewayClosed) {
      activeRequesterSettleWakeBatches.delete(wakeKeyBase);
    }
  }
}
