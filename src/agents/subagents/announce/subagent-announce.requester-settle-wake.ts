import { withGoalContinuationSettlement } from "../../../auto-reply/reply/goal-continuation-return.js";
import { getRuntimeConfig } from "../../../config/config.js";
import { isOperatorAuthorityUnavailable } from "../../../infra/operator-authority-error.js";
import { getSharedGatewayContextResolver } from "../../../plugins/runtime/gateway-request-scope.js";
import {
  retireSessionControllerInput,
  type SessionControllerInput,
} from "../../../sessions/session-controller.mailbox.js";
import { isCronSessionKey } from "../../../sessions/session-key-utils.js";
import { normalizeDeliveryContext } from "../../../utils/delivery-context.shared.js";
import { isAgentRunRestartAbortReason } from "../../run-termination.js";
import { resolveSubagentRequesterAgentId } from "../../subagent-requester-owner.js";
import {
  getFollowupForCohort,
  withFollowupSuccessor,
} from "../completion/session-followup-completion.js";
import {
  hasConsumedRequesterInput,
  resolveRequesterDeliveryOutcome,
} from "../registry/subagent-delivery-state.js";
import { withSubagentProgressDraft } from "../registry/subagent-progress-draft.js";
import { subagentRuns } from "../registry/subagent-registry-memory.js";
import { selectConnectedSettledSubagentWave } from "../registry/subagent-registry-queries.js";
import {
  getLatestLiveSubagentRunByChildSessionKey,
  listSubagentRunsForRequester,
} from "../registry/subagent-registry-read.js";
import type { SubagentRunRecord } from "../registry/subagent-registry.types.js";
import { observeSubagentRequesterDelivery } from "../registry/subagent-requester-delivery.js";
import {
  buildRequesterSettleWakeIdentity,
  hasRequesterCompletionCohort,
  resolveCurrentRequesterSettleWakeBatch,
  settledCompletions,
} from "../registry/subagent-requester-settle-identity.js";
import { isClaimedByLiveRequesterTurn } from "../registry/subagent-requester-turn-liveness.js";
import { isSameSubagentRunOwner } from "../registry/subagent-run-generation.js";
import { captureRequesterContinuationCaller } from "../requester-cron-authority.js";
import { transferRequesterFinalAttachment } from "../requester-final-attachment.js";
import { getSubagentDepthFromSessionStoreInWorker } from "../spawn/subagent-depth.js";
import { reserveSubagentControllerSource } from "./subagent-announce-controller-source.js";
import { classifyAnnounceDeliveryError } from "./subagent-announce-delivery-retry.js";
import {
  deliverSubagentAnnouncement,
  loadRequesterSessionEntry,
} from "./subagent-announce-delivery.js";
import {
  withSubagentRequesterSource,
  captureRequesterSessionEntryCurrent,
  hasUsableSessionEntry,
} from "./subagent-announce-delivery.runtime.js";
import { resolveAnnounceOrigin } from "./subagent-announce-origin.js";
import {
  readChildCompletionFindings,
  selectCurrentRequesterCompletionRows,
} from "./subagent-announce-output.js";
import { createRequesterDescendantReader } from "./subagent-announce.requester-settle-descendants.js";
import { buildRequesterSettleWakeMessage } from "./subagent-announce.requester-settle-message.js";
import { createRequesterSettleReceiptAdmission } from "./subagent-announce.requester-settle-receipt.js";
import {
  readSharedBatchState,
  createRequesterSettleBatchCompletion,
  needsRequesterSettleFindings,
  isRequesterSettleMemberReady,
  captureRequesterRunOwner,
  isRequesterSettleDeliveryClosed,
  resolveRequesterSettlePolicy,
  waitForRequesterDescendants,
  type RequesterSettleWakeParams,
} from "./subagent-announce.requester-settle-state.js";

/**
 * Arms the one requester continuation a settled batch owes. The continuation is a single
 * controller input on the requester session: the mailbox decides when it runs, and its
 * outcome is recorded once. Known nondelivery retains a due row for the live sweep;
 * this owner never schedules a timer or replays an uncertain effect.
 */
export async function maybeWakeRequesterAfterAllChildrenSettled(
  params: RequesterSettleWakeParams,
): Promise<boolean> {
  let input: SessionControllerInput | undefined;
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
      return maybeWakeRequesterAfterAllChildrenSettledBound({
        ...guardedParams,
        onControllerInput: (reserved) => {
          input = reserved;
        },
      });
    },
    () => input,
  );
}

async function maybeWakeRequesterAfterAllChildrenSettledBound(
  params: Parameters<typeof maybeWakeRequesterAfterAllChildrenSettled>[0] & {
    onControllerInput: (input: SessionControllerInput) => void;
  },
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
  const completeBatch = createRequesterSettleBatchCompletion({
    completeBatch: params.completeBatch,
    requesterAgentId,
    requesterSessionKey,
    pause,
  });
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
  // Only the admitted generation may inspect descendants or settle its batch.
  if (
    !currentSettledEntry ||
    !isSameSubagentRunOwner(currentSettledEntry, params.settledEntry) ||
    !currentState ||
    currentState.rearmGeneration !== initialState.rearmGeneration
  ) {
    return false;
  }
  const frozenBatchRunIds = currentState.batchRunIds;
  const frozen = Boolean(frozenBatchRunIds?.length);
  const currentRearmGeneration = currentState.rearmGeneration;
  const hasCurrentWake = (entry: SubagentRunRecord | undefined): entry is SubagentRunRecord =>
    Boolean(entry?.requesterSettleWake) &&
    entry?.requesterSettleWake?.rearmGeneration === currentRearmGeneration;
  let settledBatch: readonly SubagentRunRecord[];
  if (pauseNotice) {
    settledBatch = [currentSettledEntry];
  } else if (frozenBatchRunIds && frozen) {
    const runsById = new Map(requesterRuns.map((entry) => [entry.runId, entry]));
    // Retired rows no longer own completion, but every surviving frozen member
    // must be terminal before this batch can wake its requester.
    settledBatch = subagentRuns.selectCompletionAuthorityBatch(
      frozenBatchRunIds.map((runId) => runsById.get(runId)).filter(hasCurrentWake),
      currentSettledEntry,
    );
    if (!settledBatch.every(isRequesterSettleMemberReady)) {
      params.onDescendantsPending?.();
      return false;
    }
  } else {
    // An unfrozen wave cannot absorb a different requester-yield generation.
    settledBatch = selectConnectedSettledSubagentWave(
      subagentRuns.selectCompletionAuthorityBatch(
        requesterRuns.filter(
          (entry) => hasCurrentWake(entry) && isRequesterSettleMemberReady(entry),
        ),
        currentSettledEntry,
      ),
      currentSettledEntry,
    );
  }
  // A live requester turn owns its bound children until its own transfer releases them.
  if (settledBatch.length === 0 || settledBatch.some(isClaimedByLiveRequesterTurn)) {
    return false;
  }

  const resolveGatewayContext = getSharedGatewayContextResolver(settledBatch);
  const hadGatewayContext = resolveGatewayContext ? Boolean(resolveGatewayContext()) : false;
  if (resolveGatewayContext && !hadGatewayContext) {
    return false;
  }
  const isGatewayClosed = () => {
    try {
      return hadGatewayContext && !resolveGatewayContext?.();
    } catch {
      return hadGatewayContext;
    }
  };

  const preparation = requesterAgentId
    ? resolveGatewayContext?.()?.agentDatabaseStartup?.waitForAgentPreparation(requesterAgentId, {
        signal: params.signal,
      })
    : undefined;
  if (preparation) {
    await preparation;
    if (params.signal?.aborted || !params.isSourceCurrent()) {
      return false;
    }
  }
  const batchRunIds = settledBatch.map((entry) => entry.runId).toSorted();
  const batchSessionKeys = [...new Set(settledBatch.map((run) => run.childSessionKey))].toSorted();
  const currentCompletionRows = (rows: readonly SubagentRunRecord[]) =>
    selectCurrentRequesterCompletionRows({
      rows,
      requesterSessionKey,
      requesterAgentId,
      frozenBatch: frozen,
      latestForSession: getLatestLiveSubagentRunByChildSessionKey,
    });
  const readCurrentBatch = () =>
    resolveCurrentRequesterSettleWakeBatch({
      observed: settledBatch,
      // Exact cohort custody survives a member's result becoming obsolete.
      // Findings below still use the current-source filter independently.
      currentRuns: readRequesterRuns(),
      rearmGeneration: currentRearmGeneration,
      pause,
      isClaimedByLiveRequesterTurn,
    });
  const isBatchCurrent = () => readCurrentBatch() !== undefined;
  const refreshBatch = (): boolean => {
    const current = readCurrentBatch();
    if (!current) {
      return false;
    }
    settledBatch = current;
    return true;
  };
  const selectedState = readSharedBatchState(settledBatch);

  // Keep the batch members themselves in the settle check, including paused work.
  const readRequesterDescendants = createRequesterDescendantReader({
    requesterSessionKey,
    requesterAgentId,
    requesterStorePath,
    settledEntry: currentSettledEntry,
    settledBefore: Math.min(...settledBatch.map((entry) => entry.createdAt)),
    rootRunIds: frozen ? new Set(batchRunIds) : undefined,
    signal: params.signal,
    isSourceCurrent: params.isSourceCurrent,
  });
  // Descendant settlement re-arms this wake; an unsettled tree is not yet owed.
  const initialDescendants = await readRequesterDescendants();
  if (!initialDescendants) {
    return false;
  }
  const waitForDescendants = (facts: NonNullable<typeof initialDescendants>) =>
    !pauseNotice && waitForRequesterDescendants(facts, frozen, params.onDescendantsPending);
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
  const isBatchDeliveryClosed = () =>
    isRequesterSettleDeliveryClosed({
      requesterRun,
      currentRequester: getRequesterRun(),
      currentRuns: readRequesterRuns(),
      batch: settledBatch,
      requesterYieldBatch: selectedState.requesterYieldBatch === true,
    });
  if (isBatchDeliveryClosed()) {
    // Cancellation already owns the task result; only consume its obsolete wake.
    await completeBatch(settledBatch, selectedState);
    return false;
  }
  const requiredSettled = settledBatch.filter((entry) => entry.expectsCompletionMessage === true);
  // A yielded batch owns a rearm generation even when its child settles later.
  const requesterYieldedAfterDelivery =
    selectedState.afterRequesterYield === true ||
    (selectedState.requesterYieldBatch === true && selectedState.rearmGeneration !== undefined);
  const requesterDepth = await getSubagentDepthFromSessionStoreInWorker(requesterSessionKey, {
    cfg,
    agentId: requesterAgentId,
  });
  // A retained completion cohort owns continuation at every depth.
  // Ordinary nested waves remain owned by the descendant-settle path.
  if (
    !pauseNotice &&
    ((requiredSettled.every((entry) => !needsRequesterSettleFindings(entry)) &&
      (requiredSettled.length === 0 || !requesterYieldedAfterDelivery)) ||
      (!requesterYieldedAfterDelivery &&
        !hasRequesterCompletionCohort(currentSettledEntry) &&
        requesterDepth >= 1))
  ) {
    await completeBatch(settledBatch, selectedState);
    return false;
  }
  // Only an owed continuation waits for descendants. An entirely delivered
  // wave must not retain its redundant wake behind unrelated running siblings.
  if (waitForDescendants(initialDescendants)) {
    return false;
  }

  const requesterCurrent = await captureRequesterSessionEntryCurrent(
    requesterSessionKey,
    requesterAgentId,
  );
  let controllerInput: SessionControllerInput | undefined;
  try {
    const requester = await loadRequesterSessionEntry(requesterSessionKey, requesterAgentId);
    const requesterEntry = requester.entry;
    if (!hasUsableSessionEntry(requesterEntry)) {
      // Startup or requester cleanup can temporarily close admission; the durable wake stays owed.
      return false;
    }

    const completionRows = currentCompletionRows(settledBatch);
    if (completionRows.length === 0) {
      await completeBatch(settledBatch, selectedState);
      return false;
    }
    // Delivered children remain in yield cohorts; the admitted marker owns whether
    // the requester may deliver its final under the conversation's reply policy.
    const { privateRows, requireVisibleReply, parentOnly, requesterBinding, admissionMarker } =
      resolveRequesterSettlePolicy(completionRows, requesterYieldedAfterDelivery, selectedState);
    const preparedFindings = pauseNotice
      ? { text: pauseNotice.acknowledgment, isCurrent: () => true }
      : await readChildCompletionFindings(completionRows.filter(needsRequesterSettleFindings));
    // Recheck owned descendants after loading findings and before dispatch.
    const currentDescendants = await readRequesterDescendants();
    if (
      !currentDescendants ||
      !params.isSourceCurrent() ||
      !refreshBatch() ||
      waitForDescendants(currentDescendants)
    ) {
      return false;
    }
    const state = { ...readSharedBatchState(settledBatch), ...admissionMarker };
    const identity = buildRequesterSettleWakeIdentity({
      requesterSessionKey,
      requesterAgentId,
      batchRunIds,
      rearmGeneration: selectedState.rearmGeneration,
      pause,
      retainedWake: state,
      hasPrivateCompletion: privateRows.length > 0,
    });
    const knownNondelivery = state.status === "pending" && state.nextAttemptAt !== undefined;
    const { batchKey } = identity;
    const directIdempotencyKey = identity.runId;
    const sourceReceiptAdmission = createRequesterSettleReceiptAdmission({
      requester,
      readCurrent: requesterCurrent.readCurrent,
    });
    const isRequesterCurrent = () => {
      if (!sourceReceiptAdmission.isRequesterCurrent()) {
        return false;
      }
      if (followup) {
        try {
          followup.assertCurrent();
          return true;
        } catch (error) {
          if (isOperatorAuthorityUnavailable(error)) {
            throw error;
          }
          return false;
        }
      }
      return isRequesterRunCurrent(getRequesterRun(), directIdempotencyKey);
    };
    const areCompletionRowsCurrent = () => {
      const currentRows = currentCompletionRows(readCurrentBatch() ?? []);
      return completionRows.every((observed) =>
        currentRows.some((row) => isSameSubagentRunOwner(row, observed)),
      );
    };
    const isSourceSessionEffectsAllowed = () =>
      !params.signal?.aborted &&
      params.isSourceCurrent() &&
      preparedFindings.isCurrent() &&
      !isGatewayClosed() &&
      areCompletionRowsCurrent() &&
      isRequesterCurrent() &&
      !isBatchDeliveryClosed();
    const continuationCaller = captureRequesterContinuationCaller({
      requesterSessionKey,
      requesterSessionId: requesterEntry.sessionId,
      requesterAgentId,
      batch: settledBatch,
      rearmGeneration: state.requesterYieldBatch ? state.rearmGeneration : undefined,
      runId: directIdempotencyKey,
      isCurrent: isSourceSessionEffectsAllowed,
      deliveryRoute: normalizeDeliveryContext(params.requesterOrigin),
    });
    const requesterSessionOrigin = continuationCaller.deliveryRoute;
    const directOrigin = resolveAnnounceOrigin(requesterEntry, requesterSessionOrigin);
    // The request hash covers raw input, before transcript hooks. Keep those exact bytes
    // in the wake owner; the accepted transcript may contain only the hook's projection.
    const wakeMessage = buildRequesterSettleWakeMessage({
      findings: preparedFindings.text,
      requireVisibleReply,
      parentOnly,
      yieldedFinalDeliverable: admissionMarker.yieldedFinalDeliverable,
      descendantsUnsettled: !pauseNotice && currentDescendants.unsettled,
      children: completionRows,
      completionChannel: directOrigin?.channel,
      requesterOrigin: directOrigin,
      retainedMessage:
        parentOnly && state.privateInput?.runId === directIdempotencyKey
          ? state.privateInput.message
          : undefined,
      retryMissingResult: !parentOnly && knownNondelivery && state.attemptCount > 0,
    });
    const dispatchState = parentOnly
      ? { ...state, privateInput: { runId: directIdempotencyKey, message: wakeMessage } }
      : state;
    controllerInput = await reserveSubagentControllerSource(
      settledBatch[0]!,
      batchKey,
      directIdempotencyKey,
      continuationCaller,
      { requester },
    );
    if (!controllerInput) {
      return false;
    }
    params.onControllerInput(controllerInput);
    // A live settle check may find this same input waiting in the mailbox.
    if (controllerInput.custody.rpcAdopted) {
      return false;
    }
    const retireUnadoptedInput = () => {
      if (controllerInput && !controllerInput.custody.rpcAdopted) {
        retireSessionControllerInput(controllerInput);
      }
    };
    // Revocation or retirement owns a changed batch: record nothing, or consume the obsolete wake.
    // A stopped evaluation records nothing; the durable wake stays owed.
    const settleRevokedBatch = async (): Promise<boolean> => {
      if (
        controllerInput?.abortSignal.aborted &&
        !controllerInput.custody.rpcAdopted &&
        !dispatchAccepted &&
        params.isSourceCurrent() &&
        isBatchCurrent() &&
        !isBatchDeliveryClosed() &&
        isRequesterCurrent() &&
        !isGatewayClosed()
      ) {
        // Cancellation refused before Gateway admission: keep the unspent durable obligation.
        await params.transitionBatch(settledBatch, state, refreshBatch);
        return true;
      }
      if (
        params.signal?.aborted ||
        isAgentRunRestartAbortReason(controllerInput?.abortSignal.reason) ||
        isGatewayClosed() ||
        !isBatchCurrent()
      ) {
        return true;
      }
      if (!isBatchDeliveryClosed() && isRequesterCurrent()) {
        return false;
      }
      // Requester turnover closes this attempt, not the child's pending question.
      if (!pauseNotice || isBatchDeliveryClosed() || !sourceReceiptAdmission.isRequesterCurrent()) {
        await completeBatch(settledBatch, state);
      }
      return true;
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
    let dispatchPrepared = false;
    let dispatchAccepted = false;
    const attemptCount =
      state.status === "dispatching" ? state.attemptCount : Math.max(1, state.attemptCount + 1);
    let delivery: Awaited<ReturnType<typeof deliverSubagentAnnouncement>>;
    const waitForRequesterDelivery =
      !pauseNotice && params.recordRequesterDelivery
        ? observeSubagentRequesterDelivery(controllerInput, (fact) =>
            params.recordRequesterDelivery!(settledBatch, fact, refreshBatch),
          )
        : undefined;
    try {
      const requesterDelivery = pauseNotice
        ? undefined
        : {
            state: "waiting" as const,
            runId: directIdempotencyKey,
            at: Date.now(),
            blockingRunId: controllerInput.mailbox.claim?.inputs.find(
              (source) => source !== controllerInput,
            )?.protocolRunId,
          };
      const dispatch = () => {
        const deliver = () =>
          deliverSubagentAnnouncement({
            requesterSessionKey,
            requesterAgentId,
            triggerMessage: wakeMessage,
            subagentCompletions: pauseNotice ? undefined : settledCompletions(completionRows),
            requesterSessionOrigin,
            directOrigin,
            sourceSessionKey: batchSessionKeys[0],
            settleWakeSourceSessionKeys: batchSessionKeys,
            sourceTool: "subagent_settle",
            targetRequesterSessionKey: requesterSessionKey,
            requesterIsSubagent: requesterDepth >= 1,
            expectsCompletionMessage: false,
            ...requesterBinding,
            ...(!pauseNotice && requireVisibleReply ? { requireVisibleReply } : {}),
            directIdempotencyKey,
            signal: params.signal,
            resolveGatewayContext,
            isSourceSessionEffectsAllowed,
            sourceReceiptAdmission,
            controllerInput,
            onAccepted: () => {
              dispatchAccepted = true;
              params.onAccepted?.();
            },
            onExecutionStarted: () => {
              dispatchAccepted = true;
              params.onAccepted?.();
            },
            onBeforeDispatch: async () => {
              await params.transitionBatch(
                settledBatch,
                {
                  ...dispatchState,
                  // A pause owns one source without replacing its full yielded cohort.
                  batchRunIds: pauseNotice ? dispatchState.batchRunIds : batchRunIds,
                  status: "dispatching",
                  attemptCount,
                  nextAttemptAt: undefined,
                  lastError: undefined,
                },
                refreshBatch,
                requesterDelivery,
              );
              dispatchPrepared = true;
            },
          });
        return withGoalContinuationSettlement(
          settledBatch,
          directIdempotencyKey,
          () => !pauseNotice && isSourceSessionEffectsAllowed(),
          () => {
            if (!isSourceSessionEffectsAllowed()) {
              throw new Error("Requester completion source changed before continuation admission.");
            }
            return subagentRuns.runWithCompletionBatchAuthority(settledBatch, deliver);
          },
        );
      };
      try {
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
      } finally {
        await waitForRequesterDelivery?.();
      }
    } catch (error) {
      retireUnadoptedInput();
      if (!dispatchPrepared) {
        throw error;
      }
      if (await settleRevokedBatch()) {
        return false;
      }
      delivery = classifyAnnounceDeliveryError(error, {
        path: "none",
        beforeAdmission: !dispatchAccepted && !controllerInput?.custody.rpcAdopted,
      });
    }
    if (delivery.disposition !== "session_queued") {
      retireUnadoptedInput();
    }
    // Results committed to the requester transcript are never replayed: settle what the turn did.
    const currentBatch = readCurrentBatch() ?? settledBatch;
    delivery = resolveRequesterDeliveryOutcome(currentBatch, delivery)!;
    if (delivery.delivered || currentBatch.every(hasConsumedRequesterInput)) {
      await completeBatch(settledBatch, state, delivery, requesterEntry.sessionId);
      return delivery.delivered;
    }
    // The controller mailbox owns a queued handoff and settles it itself.
    if ((await settleRevokedBatch()) || delivery.disposition === "session_queued") {
      return false;
    }
    // A permanent refusal withholds the result visibly; it stays readable in the child session.
    if (delivery.disposition === "permanent_failure") {
      await completeBatch(settledBatch, state, delivery, requesterEntry.sessionId);
      return false;
    }
    // Any other uncommitted result stays owed; the sweeper wakes it again. Nothing expires it.
    await params.transitionBatch(
      settledBatch,
      {
        ...dispatchState,
        status: "pending",
        attemptCount,
        nextAttemptAt: Date.now(),
        lastError: delivery.error ?? delivery.reason ?? "undelivered",
      },
      refreshBatch,
    );
    return false;
  } finally {
    if (controllerInput) {
      // Queued admission still consumes this current-source guard after its observer returns.
      void controllerInput.settlement.promise.then(
        requesterCurrent.release,
        requesterCurrent.release,
      );
    } else {
      requesterCurrent.release();
    }
  }
}
