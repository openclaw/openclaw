/** Deliver drained requester waves; lifecycle owns their persisted outbox on retained run rows. */
import { getRuntimeConfig } from "../../../config/config.js";
import { isSystemEventStoreCurrent } from "../../../infra/system-event-ownership.js";
import { logWarn } from "../../../logger.js";
import { getSharedGatewayContextResolver } from "../../../plugins/runtime/gateway-request-scope.js";
import { isCronSessionKey } from "../../../sessions/session-key-utils.js";
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
import { withSubagentProgressDraft } from "../registry/subagent-progress-draft.js";
import { isQuietSubagentRestartContinuation } from "../registry/subagent-recovery-state.js";
import { subagentRuns } from "../registry/subagent-registry-memory.js";
import {
  matchesSubagentRequesterSession,
  selectConnectedSettledSubagentWave,
} from "../registry/subagent-registry-queries.js";
import {
  getLatestLiveSubagentRunByChildSessionKey,
  listSubagentRunsForRequester,
} from "../registry/subagent-registry-read.js";
import type { SubagentRunRecord } from "../registry/subagent-registry.types.js";
import {
  buildRequesterSettleWakeIdentity,
  hasRequesterCompletionCohort,
  resolveCurrentRequesterSettleWakeBatch,
} from "../registry/subagent-requester-settle-identity.js";
import { isSameSubagentRunOwner } from "../registry/subagent-run-generation.js";
import { hasSubagentRunEnded } from "../registry/subagent-run-liveness.js";
import { withRequesterCronAuthority } from "../requester-cron-authority.js";
import {
  finalizeRequesterFinalAttachment,
  transferRequesterFinalAttachment,
} from "../requester-final-attachment.js";
import { getSubagentDepthFromSessionStore } from "../spawn/subagent-depth.js";
import { isPermanentAnnounceDeliveryError } from "./subagent-announce-delivery-retry.js";
import {
  deliverSubagentAnnouncement,
  loadRequesterSessionEntry,
} from "./subagent-announce-delivery.js";
import {
  withSubagentRequesterSource,
  captureRequesterSessionEntryCurrent,
  hasUsableSessionEntry,
} from "./subagent-announce-delivery.runtime.js";
import type { SubagentAnnounceDeliveryResult } from "./subagent-announce-dispatch.js";
import { resolveAnnounceOrigin } from "./subagent-announce-origin.js";
import {
  readChildCompletionFindings,
  selectCurrentRequesterCompletionRows,
} from "./subagent-announce-output.js";
import { SubagentAnnouncePreparationConflictError } from "./subagent-announce-result.js";
import { createRequesterDescendantReader } from "./subagent-announce.requester-settle-descendants.js";
import { buildRequesterSettleWakeMessage } from "./subagent-announce.requester-settle-message.js";
import { createRequesterSettleReceiptAdmission } from "./subagent-announce.requester-settle-receipt.js";
import {
  readSharedBatchState,
  createRequesterSettleBatchClaim,
  createRequesterSettleBatchDeferral,
  captureRequesterRunOwner,
  resolvePrivateSettlePolicy,
  retainedYieldIdentity,
  startRequesterSettleWakeAttempt,
  deferRequesterSettleWakePreparation,
  type RequesterSettleWakeBatchState,
  type RequesterSettleWakeBatchCallbacks,
} from "./subagent-announce.requester-settle-state.js";

const REQUESTER_SETTLE_WAKE_MAX_ATTEMPTS = 3;
const REQUESTER_SETTLE_WAKE_MAX_AMBIGUOUS_REPLAYS = 3;
const REQUESTER_SETTLE_WAKE_RETRY_DELAYS_MS = [30_000, 120_000] as const;

/** Wake top-level or yielded requesters after their descendants settle; lifecycle owns transitions. */
export async function maybeWakeRequesterAfterAllChildrenSettled(
  params: RequesterSettleWakeBatchCallbacks & {
    requesterSessionKey: string;
    requesterOrigin?: DeliveryContext;
    settledEntry: SubagentRunRecord;
    signal?: AbortSignal;
    isSourceCurrent: () => boolean;
  },
): Promise<boolean> {
  return withSubagentRequesterSource(
    params.requesterSessionKey,
    params.settledEntry.requesterAgentId,
    async (isRequesterCurrent): Promise<boolean> => {
      const guardedParams = isRequesterCurrent
        ? {
            ...params,
            isSourceCurrent: () => isRequesterCurrent() && params.isSourceCurrent(),
          }
        : params;
      return maybeWakeRequesterAfterAllChildrenSettledBound(guardedParams);
    },
  );
}

async function maybeWakeRequesterAfterAllChildrenSettledBound(
  params: Parameters<typeof maybeWakeRequesterAfterAllChildrenSettled>[0],
): ReturnType<typeof maybeWakeRequesterAfterAllChildrenSettled> {
  if (params.signal?.aborted || !params.isSourceCurrent()) {
    return false;
  }
  const requesterSessionKey = params.requesterSessionKey.trim();
  const cfg = getRuntimeConfig();
  const requesterAgentId = resolveSubagentRequesterAgentId(cfg, params.settledEntry);
  const requesterStorePath = params.settledEntry.requesterStorePath ?? null;
  const initialState = params.settledEntry.requesterSettleWake;
  const pauseNotice =
    params.settledEntry.pauseReason === "sessions_yield" ? initialState?.pauseNotice : undefined;
  const pause = pauseNotice !== undefined;
  if (!requesterSessionKey || !initialState) {
    return false;
  }
  const readRequesterRuns = () =>
    listSubagentRunsForRequester(requesterSessionKey, { requesterAgentId, requesterStorePath });
  let batchClaim: ReturnType<typeof createRequesterSettleBatchClaim> = undefined;
  const completeBatch = async (
    batch: readonly SubagentRunRecord[],
    state: RequesterSettleWakeBatchState,
    delivery?: SubagentAnnounceDeliveryResult,
    requesterSessionId?: string,
  ): Promise<void> => {
    if (batchClaim?.claim() === false) {
      return;
    }
    await params.completeBatch(batch, state.rearmGeneration, delivery, () =>
      finalizeRequesterFinalAttachment({
        requesterAgentId,
        requesterSessionKey,
        requesterSessionId,
        batchRunIds: batch.map((entry) => entry.runId).toSorted(),
        rearmGeneration: state.rearmGeneration,
        requesterYieldBatch: state.requesterYieldBatch,
        pause,
        delivered: delivery?.delivered,
        finalAssistantVisibleText: delivery?.finalAssistantVisibleText,
      }),
    );
  };
  const admittedRearmGeneration = initialState.rearmGeneration;
  if (isCronSessionKey(requesterSessionKey)) {
    await completeBatch([params.settledEntry], initialState);
    return false;
  }

  const requesterRuns = readRequesterRuns();
  const currentSettledEntry = requesterRuns.find(
    (entry) => entry.runId === params.settledEntry.runId,
  );
  const currentState = currentSettledEntry?.requesterSettleWake;
  // A requester yield may re-arm this row while runtime loading is in flight.
  // Only the admitted generation may inspect descendants or mutate its batch.
  if (
    !currentSettledEntry ||
    !isSameSubagentRunOwner(currentSettledEntry, params.settledEntry) ||
    !currentState ||
    currentState.rearmGeneration !== admittedRearmGeneration
  ) {
    return false;
  }
  const frozenBatchRunIds = currentState.batchRunIds;
  const frozen = Boolean(frozenBatchRunIds?.length);
  const currentRearmGeneration = currentState.rearmGeneration;
  const hasCurrentWake = (entry: SubagentRunRecord | undefined): entry is SubagentRunRecord =>
    Boolean(entry?.requesterSettleWake) &&
    entry?.requesterSettleWake?.rearmGeneration === currentRearmGeneration;
  const hasSettled = (entry: SubagentRunRecord) =>
    entry.execution.status !== "running" &&
    entry.pauseReason !== "sessions_yield" &&
    hasSubagentRunEnded(entry);
  let settledBatch: SubagentRunRecord[];
  if (pauseNotice) {
    settledBatch = [currentSettledEntry];
  } else if (frozenBatchRunIds && frozen) {
    const runsById = new Map(requesterRuns.map((entry) => [entry.runId, entry]));
    // Retired rows no longer own completion, but every surviving frozen member
    // must be terminal before this batch can wake its requester.
    settledBatch = frozenBatchRunIds.map((runId) => runsById.get(runId)).filter(hasCurrentWake);
    if (!settledBatch.every(hasSettled)) {
      return false;
    }
  } else {
    // An unfrozen wave cannot absorb a different requester-yield generation.
    // Its frozen cohort still owns its deadline, retry budget, and visible final.
    settledBatch = selectConnectedSettledSubagentWave(
      requesterRuns.filter((entry) => hasCurrentWake(entry) && hasSettled(entry)),
      currentSettledEntry,
    );
  }
  // Required completions stay with their requester turn; other rows keep its ID for cancellation.
  if (
    settledBatch.length === 0 ||
    settledBatch.some((run) => run.expectsCompletionMessage === true && run.requesterTurnRunId)
  ) {
    return false;
  }

  const transitionBatch = async (state: RequesterSettleWakeBatchState): Promise<void> => {
    let published = false;
    await params.transitionBatch(settledBatch, state, (entries) => {
      settledBatch = [...entries];
      published = true;
    });
    if (!published) {
      throw new Error("Requester wake transition was not published");
    }
  };

  const resolveGatewayContext = getSharedGatewayContextResolver(settledBatch);
  const batchRunIds = settledBatch.map((entry) => entry.runId).toSorted();
  const batchSessionKeys = [...new Set(settledBatch.map((run) => run.childSessionKey))].toSorted();
  const currentCompletionRows = (rows: SubagentRunRecord[]) =>
    selectCurrentRequesterCompletionRows({
      rows,
      requesterSessionKey,
      requesterAgentId,
      frozenBatch: frozen,
      latestForSession: getLatestLiveSubagentRunByChildSessionKey,
    });
  const readCurrentBatch = (requireUnchangedProgress = false) =>
    resolveCurrentRequesterSettleWakeBatch({
      observed: settledBatch,
      currentRuns: currentCompletionRows(readRequesterRuns()),
      rearmGeneration: currentRearmGeneration,
      pause,
      requireUnchangedProgress,
    });
  const isBatchCurrent = () => readCurrentBatch(true) !== undefined;
  const refreshBatch = (): boolean => {
    const current = readCurrentBatch();
    if (!current) {
      return false;
    }
    // Retry preparation may outlive another claim's publication. Read its counters
    // from the current immutable rows after acquiring this batch's claim.
    settledBatch = current;
    return true;
  };
  const selectedState = readSharedBatchState(settledBatch);
  const failBatch = (state: RequesterSettleWakeBatchState, error: string) =>
    completeBatch(settledBatch, state, { delivered: false, path: "none", error });
  const { batchKey: wakeKeyBase } = buildRequesterSettleWakeIdentity({
    requesterSessionKey,
    requesterAgentId,
    batchRunIds,
    rearmGeneration: selectedState.rearmGeneration,
    pause,
  });
  const claim = createRequesterSettleBatchClaim(
    wakeKeyBase,
    resolveGatewayContext ? () => Boolean(resolveGatewayContext()) : undefined,
  );
  if (!claim) {
    return false;
  }
  const { isGatewayClosed, claim: acquireBatch } = claim;
  batchClaim = claim;
  let requesterCurrent: Awaited<ReturnType<typeof captureRequesterSessionEntryCurrent>> | undefined;

  try {
    // Scheduling is per child, but every replay of this frozen wave is one input.
    // Retain all possible shipped sources only for exact accepted-input matching.
    const batchCreatedAt = Math.min(...settledBatch.map((entry) => entry.createdAt));
    // Keep the batch members themselves in the settle check, including paused work.
    const rootRunIds = frozen ? new Set(frozenBatchRunIds) : undefined;
    const readRequesterDescendants = createRequesterDescendantReader({
      requesterSessionKey,
      requesterAgentId,
      requesterStorePath,
      settledEntry: currentSettledEntry,
      settledBefore: batchCreatedAt,
      rootRunIds,
      signal: params.signal,
      isSourceCurrent: params.isSourceCurrent,
    });
    const initialDescendants = await readRequesterDescendants();
    if (!initialDescendants) {
      return false;
    }
    const hasUnsettledDescendants = !pauseNotice && initialDescendants.unsettled;
    if (!frozen && hasUnsettledDescendants) {
      return false;
    }

    const retainedBatchRunIds = pauseNotice ? frozenBatchRunIds : batchRunIds;
    const isStoreCurrent = () =>
      settledBatch.every((entry) =>
        isSystemEventStoreCurrent(requesterSessionKey, entry.requesterStorePath, requesterAgentId),
      );
    const retireReplacedStore = async (): Promise<boolean> => {
      if (isStoreCurrent()) {
        return false;
      }
      await completeBatch(settledBatch, selectedState, {
        delivered: false,
        path: "none",
        error: "store replaced",
        storeReplaced: true,
        disposition: "intentional_non_delivery",
      });
      return true;
    };
    if (await retireReplacedStore()) {
      return false;
    }
    const followup = pauseNotice ? undefined : getFollowupForCohort(settledBatch);
    const getRequesterRun = () =>
      followup
        ? undefined
        : (getLatestLiveSubagentRunByChildSessionKey(
            requesterSessionKey,
            (entry) => entry.pauseReason === "sessions_yield",
            requesterAgentId,
          ) ??
          getLatestLiveSubagentRunByChildSessionKey(
            requesterSessionKey,
            undefined,
            requesterAgentId,
          ));
    const requesterRun = getRequesterRun();
    const isRequesterRunCurrent = captureRequesterRunOwner(requesterRun);
    const isBatchDeliveryClosed = () => {
      const currentRequester = getRequesterRun();
      const currentRuns = readRequesterRuns();
      const currentBatch = settledBatch.map(
        (entry) => currentRuns.find((current) => isSameSubagentRunOwner(current, entry)) ?? entry,
      );
      return (
        requesterRun?.killReconciliation?.suppressTaskDelivery === true ||
        requesterRun?.suppressCompletionDelivery === true ||
        currentRequester?.killReconciliation?.suppressTaskDelivery === true ||
        currentRequester?.suppressCompletionDelivery === true ||
        // This marker is written by requester-wide abort/reset, so even a
        // completed sibling cannot keep the old frozen obligation alive.
        currentBatch.some((entry) => entry.killReconciliation?.suppressTaskDelivery === true) ||
        currentBatch.every((entry) => entry.suppressCompletionDelivery === true)
      );
    };
    if (isBatchDeliveryClosed()) {
      // Cancellation already owns the task result; only consume its obsolete wake.
      await completeBatch(settledBatch, selectedState);
      return false;
    }
    const deferBatch = createRequesterSettleBatchDeferral({
      readDescendants: readRequesterDescendants,
      claimCurrentBatch: () => acquireBatch() && params.isSourceCurrent() && refreshBatch(),
      readState: () => readSharedBatchState(settledBatch),
      transitionBatch,
      batchRunIds: retainedBatchRunIds,
      retryDelayMs: REQUESTER_SETTLE_WAKE_RETRY_DELAYS_MS[0],
    });
    // Unfrozen waves with unsettled descendants returned above; a frozen wave
    // defers until its stale-descendant wait is spent.
    if (hasUnsettledDescendants && !(await deferBatch())) {
      return false;
    }
    const interruptedContinuations = settledBatch.filter(isQuietSubagentRestartContinuation);
    const requiredSettled = settledBatch.filter(
      (entry) =>
        entry.expectsCompletionMessage === true || interruptedContinuations.includes(entry),
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
    // A retained completion cohort owns continuation at every depth.
    // Ordinary nested waves remain owned by the descendant-settle path.
    if (
      !pauseNotice &&
      (requiredSettled.length === 0 ||
        (requiredSettled.length < 2 &&
          !requiredSettled.some((entry) => entry.delivery?.status !== "delivered") &&
          !requesterYieldedAfterDelivery) ||
        (!requesterYieldedAfterDelivery &&
          interruptedContinuations.length === 0 &&
          !hasRequesterCompletionCohort(currentSettledEntry) &&
          requesterDepth >= 1))
    ) {
      await completeBatch(settledBatch, selectedState);
      return false;
    }

    requesterCurrent = await captureRequesterSessionEntryCurrent(
      requesterSessionKey,
      requesterAgentId,
    );
    const { readCurrent: readRequesterCurrent } = requesterCurrent;
    const requester = await loadRequesterSessionEntry(requesterSessionKey, requesterAgentId);
    const requesterEntry = requester.entry;
    if (!hasUsableSessionEntry(requesterEntry)) {
      await failBatch(selectedState, "requester session unavailable");
      return false;
    }

    const requesterIdentity = {
      sessionId: requesterEntry.sessionId,
      lifecycleRevision: requesterEntry.lifecycleRevision,
    };
    const completionRows = currentCompletionRows(settledBatch);
    // Delivered children remain in yield cohorts; the admitted marker owns whether
    // the requester may deliver its final under the conversation's reply policy.
    const { privateRows, requireVisibleReply, parentOnly, privateBinding, admissionMarker } =
      resolvePrivateSettlePolicy(
        completionRows,
        requesterYieldedAfterDelivery,
        selectedState,
        requesterIdentity,
      );
    // `/new` keeps the session id but rotates the lifecycle revision, so compare the
    // whole incarnation; a deliverable retry must not post old findings into a reset session.
    if (privateRows.some((entry) => !matchesSubagentRequesterSession(entry, requesterIdentity))) {
      await completeBatch(settledBatch, selectedState, {
        delivered: false,
        path: "none",
        reason: "completion_handoff_unavailable",
        error: "private completion requester session was replaced",
        terminal: true,
        disposition: "intentional_non_delivery",
      });
      return false;
    }
    const recoveryRows = completionRows.filter((entry) =>
      matchesSubagentRequesterSession(entry, requesterIdentity),
    );
    const preparedFindings = pauseNotice
      ? { text: pauseNotice.acknowledgment, isCurrent: () => true }
      : await readChildCompletionFindings(completionRows);
    if (await retireReplacedStore()) {
      return false;
    }
    const requesterSessionOrigin = normalizeDeliveryContext(params.requesterOrigin);
    const directOrigin = resolveAnnounceOrigin(requesterEntry, requesterSessionOrigin);
    const completionChannel = normalizeMessageChannel(directOrigin?.channel);
    if (params.signal?.aborted || !acquireBatch() || !refreshBatch()) {
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
    const currentDescendants = await readRequesterDescendants();
    if (!currentDescendants || !params.isSourceCurrent() || !refreshBatch()) {
      return false;
    }
    state = readSharedBatchState(settledBatch);
    const descendantsUnsettled = !pauseNotice && currentDescendants.unsettled;
    if (descendantsUnsettled) {
      if (!(await deferBatch())) {
        return false;
      }
      state = readSharedBatchState(settledBatch);
    }
    const wakeMessage = buildRequesterSettleWakeMessage({
      findings: preparedFindings.text,
      requireVisibleReply,
      parentOnly,
      yieldedFinalDeliverable: admissionMarker.yieldedFinalDeliverable,
      descendantsUnsettled,
      children: completionRows,
      recoveryChildren: recoveryRows,
      preserveModelRouteNotice:
        !completionChannel || !isDeliverableMessageChannel(completionChannel),
    });
    if (!preparedFindings.isCurrent()) {
      throw new SubagentAnnouncePreparationConflictError("Child completion preparation changed.");
    }

    const beforeDispatch = state;
    let attemptIndex: number;
    if (state.status === "dispatching") {
      // Ambiguous delivery reuses its attempt key. Completed-turn RPC replay
      // is Gateway-local; the key alone is not a cross-restart delivery receipt.
      attemptIndex = Math.max(0, state.attemptCount - 1);
    } else {
      if (state.attemptCount >= REQUESTER_SETTLE_WAKE_MAX_ATTEMPTS) {
        await failBatch(state, state.lastError ?? "requester settle wake attempts exhausted");
        return false;
      }
      attemptIndex = state.attemptCount;
      state = startRequesterSettleWakeAttempt(state, retainedBatchRunIds, admissionMarker);
      await transitionBatch(state);
    }
    if (!preparedFindings.isCurrent()) {
      // No dispatch crossed this boundary; restore its unspent reservation before retrying.
      await transitionBatch(deferRequesterSettleWakePreparation(beforeDispatch));
      return false;
    }

    const { runId: directIdempotencyKey } = buildRequesterSettleWakeIdentity({
      requesterSessionKey,
      requesterAgentId,
      batchRunIds,
      rearmGeneration: selectedState.rearmGeneration,
      attemptIndex,
      // Private turns replay under one key; a deliverable yield retries under a
      // fresh key so a cached terminal failure cannot stand in for a new send.
      sharedAttemptKey: parentOnly,
      pause,
    });
    const sourceReceiptAdmission = createRequesterSettleReceiptAdmission({
      requester,
      identity: requesterIdentity,
      storeSessionKey: requesterSessionKey,
      storeAgentId: requesterAgentId,
      storePaths: () => settledBatch.map((entry) => entry.requesterStorePath),
      isRecoveryCurrent: () =>
        recoveryRows.every((entry) => matchesSubagentRequesterSession(entry, requesterIdentity)),
      readCurrent: readRequesterCurrent,
      isStoreCurrent,
    });
    const isRequesterCurrent = () => {
      if (!sourceReceiptAdmission.isRequesterCurrent()) {
        return false;
      }
      if (followup) {
        try {
          followup.assertCurrent();
          return true;
        } catch {
          return false;
        }
      }
      return isRequesterRunCurrent(getRequesterRun(), directIdempotencyKey);
    };
    const isSourceSessionEffectsAllowed = () =>
      !params.signal?.aborted &&
      params.isSourceCurrent() &&
      sourceReceiptAdmission.isStoreCurrent() &&
      preparedFindings.isCurrent() &&
      !isGatewayClosed() &&
      isBatchCurrent() &&
      isRequesterCurrent() &&
      !isBatchDeliveryClosed();
    const settleRevokedBatch = async (knownUndelivered = false): Promise<boolean> => {
      if (isGatewayClosed() || !isBatchCurrent() || (await retireReplacedStore())) {
        return true;
      }
      if (isBatchDeliveryClosed() || !isRequesterCurrent()) {
        if (
          pauseNotice &&
          !isBatchDeliveryClosed() &&
          sourceReceiptAdmission.isRequesterCurrent()
        ) {
          // Requester turnover revokes this attempt, not the child's need for direction.
          await deferBatch(knownUndelivered ? { status: "pending" } : {}, false);
          return true;
        }
        await completeBatch(settledBatch, state);
        return true;
      }
      return false;
    };
    if (
      isSourceSessionEffectsAllowed() &&
      !pauseNotice &&
      requesterAgentId &&
      state.requesterYieldBatch &&
      state.rearmGeneration !== undefined
    ) {
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
          withRequesterCronAuthority(
            {
              requesterSessionKey,
              requesterSessionId: requesterIdentity.sessionId,
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
                triggerMessage: wakeMessage,
                requesterSessionOrigin,
                directOrigin,
                sourceSessionKey: batchSessionKeys[0],
                settleWakeSourceSessionKeys: batchSessionKeys,
                sourceTool: "subagent_settle",
                targetRequesterSessionKey: requesterSessionKey,
                requesterIsSubagent: requesterDepth >= 1,
                expectsCompletionMessage: false,
                requireDirectDelivery: true,
                ...privateBinding,
                ...(!pauseNotice && requireVisibleReply ? { requireVisibleReply } : {}),
                directIdempotencyKey,
                signal: params.signal,
                resolveGatewayContext,
                isSourceSessionEffectsAllowed,
                sourceReceiptAdmission,
              }),
          ),
        );
      delivery = await withSubagentProgressDraft(settledBatch, directIdempotencyKey, () =>
        followup
          ? withFollowupSuccessor(
              followup.successor(settledBatch, directIdempotencyKey, () => {
                if (!isSourceSessionEffectsAllowed()) {
                  throw new Error("Followup completion cohort changed.");
                }
              }),
              dispatch,
            )
          : dispatch(),
      );
    } catch (error) {
      if (await settleRevokedBatch()) {
        return false;
      }
      const lastError = error instanceof Error ? error.message : String(error);
      if (isPermanentAnnounceDeliveryError(error)) {
        await completeBatch(settledBatch, state, {
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
        await failBatch(state, lastError);
        return false;
      }
      state = {
        status: "dispatching",
        attemptCount: state.attemptCount,
        replayCount,
        nextAttemptAt: Date.now() + retryDelayMs,
        batchRunIds: retainedBatchRunIds,
        ...retainedYieldIdentity(state),
        deferralCount: state.deferralCount,
        lastError,
      };
      await transitionBatch(state);
      logWarn(
        `requester settle wake transport replay ${replayCount} scheduled in ${Math.round(retryDelayMs / 1000)}s: ${lastError}`,
      );
      return false;
    }
    if (delivery.delivered) {
      await completeBatch(settledBatch, state, delivery, requesterEntry.sessionId);
      return true;
    }
    if (await settleRevokedBatch(delivery.reason === "source_owner_changed")) {
      return false;
    }
    if (pauseNotice && delivery.reason === "source_owner_changed") {
      await deferBatch({ status: "pending" }, false);
      return false;
    }
    if (delivery.reason === "requester_turn_pending") {
      // An existing Gateway turn still owns the input. Observe the same request
      // without spending failure attempts or closing its completion obligation.
      await deferBatch({ lastError: undefined }, false);
      return false;
    }
    if (
      delivery.disposition === "ambiguous" ||
      delivery.disposition === "permanent_failure" ||
      delivery.disposition === "intentional_non_delivery" ||
      delivery.reason === "requester_abandoned"
    ) {
      await completeBatch(settledBatch, state, delivery, requesterEntry.sessionId);
      return false;
    }

    const attemptCount = attemptIndex + 1;
    const retryDelayMs = REQUESTER_SETTLE_WAKE_RETRY_DELAYS_MS[attemptIndex];
    const lastError = delivery.error ?? delivery.reason ?? "undelivered";
    if (attemptCount >= REQUESTER_SETTLE_WAKE_MAX_ATTEMPTS || retryDelayMs === undefined) {
      await completeBatch(
        settledBatch,
        state,
        { ...delivery, error: lastError },
        requesterEntry.sessionId,
      );
      return false;
    }
    await transitionBatch({
      status: "pending",
      attemptCount,
      nextAttemptAt: Date.now() + retryDelayMs,
      batchRunIds: retainedBatchRunIds,
      ...retainedYieldIdentity(state),
      deferralCount: state.deferralCount,
      lastError,
    });
    logWarn(
      `requester settle wake attempt ${attemptCount} failed; retrying in ${Math.round(retryDelayMs / 1000)}s: ${lastError}`,
    );
    return false;
  } finally {
    requesterCurrent?.release();
    claim.release();
  }
}
