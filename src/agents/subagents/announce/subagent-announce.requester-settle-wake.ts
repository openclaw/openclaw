import { withGoalContinuationSettlement } from "../../../auto-reply/reply/goal-continuation-return.js";
import { getRuntimeConfig } from "../../../config/config.js";
import { isRestartRecoveryTombstone } from "../../../config/sessions/session-work-start.js";
import { isSystemEventStoreCurrent } from "../../../infra/system-event-ownership.js";
import { getSharedGatewayContextResolver } from "../../../plugins/runtime/gateway-request-scope.js";
import {
  retireSessionControllerInput,
  type SessionControllerInput,
} from "../../../sessions/session-controller.mailbox.js";
import { isCronSessionKey } from "../../../sessions/session-key-utils.js";
import { normalizeDeliveryContext } from "../../../utils/delivery-context.shared.js";
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
import { isClaimedByLiveRequesterTurn } from "../registry/subagent-requester-turn-liveness.js";
import { isSameSubagentRunOwner } from "../registry/subagent-run-generation.js";
import { hasSubagentRunEnded } from "../registry/subagent-run-liveness.js";
import { captureRequesterContinuationCaller } from "../requester-cron-authority.js";
import { transferRequesterFinalAttachment } from "../requester-final-attachment.js";
import { getSubagentDepthFromSessionStoreInWorker } from "../spawn/subagent-depth.js";
import {
  reserveSubagentControllerSource,
  resolveRequesterSettleRecoveryCustody,
} from "./subagent-announce-controller-source.js";
import { hasAnnounceSendEvidence } from "./subagent-announce-delivery-retry.js";
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
  REQUESTER_SETTLE_WAKE_MAX_ATTEMPTS,
  needsRequesterSettleFindings,
  resolveRequesterSettleRetryState,
  captureRequesterRunOwner,
  isRequesterSettleDeliveryClosed,
  resolveRequesterSettlePolicy,
  waitForRequesterDescendants,
  type RequesterSettleWakeParams,
} from "./subagent-announce.requester-settle-state.js";

/**
 * Arms the one requester continuation a settled batch owes. The continuation is a single
 * controller input on the requester session: the mailbox decides when it runs, and its
 * outcome is recorded once. Known nondelivery retains a due row for periodic recovery;
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
      params.onDescendantsPending?.();
      return false;
    }
  } else {
    // An unfrozen wave cannot absorb a different requester-yield generation.
    settledBatch = selectConnectedSettledSubagentWave(
      requesterRuns.filter((entry) => hasCurrentWake(entry) && hasSettled(entry)),
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
  const currentCompletionRows = (rows: SubagentRunRecord[]) =>
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
  if ((selectedState.nextAttemptAt ?? 0) > Date.now()) {
    return false;
  }
  if (
    selectedState.status === "pending" &&
    selectedState.attemptCount >= REQUESTER_SETTLE_WAKE_MAX_ATTEMPTS
  ) {
    await completeBatch(settledBatch, selectedState, {
      delivered: false,
      path: "none",
      error: selectedState.lastError ?? "requester settle wake attempts exhausted",
    });
    return false;
  }

  // Keep the batch members themselves in the settle check, including paused work.
  const readRequesterDescendants = createRequesterDescendantReader({
    requesterSessionKey,
    requesterAgentId,
    requesterStorePath,
    settledEntry: currentSettledEntry,
    settledBefore: Math.min(...settledBatch.map((entry) => entry.createdAt)),
    rootRunIds: frozen ? new Set(frozenBatchRunIds) : undefined,
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
  const interruptedContinuations = settledBatch.filter(isQuietSubagentRestartContinuation);
  const requiredSettled = settledBatch.filter(
    (entry) => entry.expectsCompletionMessage === true || interruptedContinuations.includes(entry),
  );
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
        interruptedContinuations.length === 0 &&
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

    const requesterIdentity = {
      sessionId: requesterEntry.sessionId,
      lifecycleRevision: requesterEntry.lifecycleRevision,
    };
    const completionRows = currentCompletionRows(settledBatch);
    if (completionRows.length === 0) {
      await completeBatch(settledBatch, selectedState);
      return false;
    }
    const recoveryRows = completionRows.filter((entry) =>
      matchesSubagentRequesterSession(entry, requesterIdentity),
    );
    // Delivered children remain in yield cohorts; the admitted marker owns whether
    // the requester may deliver its final under the conversation's reply policy.
    const { privateRows, requireVisibleReply, parentOnly, requesterBinding, admissionMarker } =
      resolveRequesterSettlePolicy(
        completionRows,
        requesterYieldedAfterDelivery,
        selectedState,
        requesterIdentity,
        recoveryRows.length === completionRows.length,
      );
    // `/new` keeps the session id but rotates the lifecycle revision, so compare the
    // whole incarnation; a deliverable continuation must not post old findings into a reset session.
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
    const preparedFindings = pauseNotice
      ? { text: pauseNotice.acknowledgment, isCurrent: () => true }
      : await readChildCompletionFindings(completionRows.filter(needsRequesterSettleFindings));
    if (await retireReplacedStore()) {
      return false;
    }
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
    const { resolvePrivateRequesterSettleRecoveryOwner } =
      await import("../registry/subagent-registry-restart-recovery.js");
    const privateOwner =
      parentOnly && resolvePrivateRequesterSettleRecoveryOwner(requester, identity.runId);
    const recoveryCustody =
      knownNondelivery || privateOwner === "owned"
        ? undefined
        : resolveRequesterSettleRecoveryCustody(requesterEntry, identity);
    if (recoveryCustody?.status === "pending") {
      return false;
    }
    const recoveryReceiptOnly =
      !parentOnly &&
      recoveryRows.length === completionRows.length &&
      recoveryCustody?.status === "settled";
    const { batchKey } = identity;
    const directIdempotencyKey = recoveryCustody?.runId ?? identity.runId;
    const sourceReceiptAdmission = createRequesterSettleReceiptAdmission({
      requester,
      identity: requesterIdentity,
      storeSessionKey: requesterSessionKey,
      storeAgentId: requesterAgentId,
      storePaths: () => settledBatch.map((entry) => entry.requesterStorePath),
      isRecoveryCurrent: () =>
        recoveryRows.every((entry) => matchesSubagentRequesterSession(entry, requesterIdentity)),
      readCurrent: requesterCurrent.readCurrent,
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
    const areCompletionRowsCurrent = () => {
      const currentRows = currentCompletionRows(readCurrentBatch() ?? []);
      return completionRows.every((observed) =>
        currentRows.some((row) => isSameSubagentRunOwner(row, observed)),
      );
    };
    const isSourceSessionEffectsAllowed = () =>
      !params.signal?.aborted &&
      params.isSourceCurrent() &&
      sourceReceiptAdmission.isStoreCurrent() &&
      preparedFindings.isCurrent() &&
      !isGatewayClosed() &&
      areCompletionRowsCurrent() &&
      isRequesterCurrent() &&
      !isBatchDeliveryClosed();
    if (privateOwner !== "owned" && isRestartRecoveryTombstone(requesterEntry)) {
      // Keep the owed result with its owner; a child completion cannot authorize Resume.
      await sourceReceiptAdmission.appendRecoveryWaitNotice(
        `${batchKey}:restart-wait:${requesterEntry.mainRestartRecovery?.cycleId}`,
        isSourceSessionEffectsAllowed,
      );
      return false;
    }
    const continuationCaller = captureRequesterContinuationCaller({
      requesterSessionKey,
      requesterSessionId: requesterIdentity.sessionId,
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
      recoveryChildren: recoveryRows,
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
    // A recovered final reconciles without reserving its already-consumed input again.
    if (parentOnly || recoveryCustody?.status !== "settled") {
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
      // A periodic recovery check may find the same input waiting in the mailbox.
      if (controllerInput.custody.rpcAdopted) {
        return false;
      }
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
        isGatewayClosed() ||
        !isBatchCurrent() ||
        (await retireReplacedStore())
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
    try {
      const dispatch = () => {
        const deliver = () =>
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
            ...requesterBinding,
            ...(!pauseNotice && requireVisibleReply ? { requireVisibleReply } : {}),
            directIdempotencyKey,
            signal: params.signal,
            resolveGatewayContext,
            isSourceSessionEffectsAllowed,
            sourceReceiptAdmission,
            ...(recoveryReceiptOnly ? { recoveryReceiptOnly: true as const } : {}),
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
              );
              dispatchPrepared = true;
            },
          });
        return recoveryReceiptOnly
          ? deliver()
          : withGoalContinuationSettlement(
              settledBatch,
              directIdempotencyKey,
              () => !pauseNotice && isSourceSessionEffectsAllowed(),
              () => {
                if (!isSourceSessionEffectsAllowed()) {
                  throw new Error(
                    "Requester completion source changed before continuation admission.",
                  );
                }
                return subagentRuns.runWithCompletionBatchAuthority(settledBatch, deliver);
              },
            );
      };
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
      retireUnadoptedInput();
      if (!dispatchPrepared) {
        throw error;
      }
      if (await settleRevokedBatch()) {
        return false;
      }
      // A transport exception can follow admission; it is recorded once and never replayed.
      await completeBatch(settledBatch, state, {
        delivered: false,
        path: "none",
        disposition: hasAnnounceSendEvidence(error) ? "ambiguous" : "permanent_failure",
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
    if (delivery.disposition !== "session_queued") {
      retireUnadoptedInput();
    }
    if (recoveryReceiptOnly && !isSourceSessionEffectsAllowed()) {
      return false;
    }
    if (delivery.delivered) {
      await completeBatch(settledBatch, state, delivery, requesterEntry.sessionId);
      return true;
    }
    // The controller mailbox owns a queued handoff and settles it itself.
    if ((await settleRevokedBatch()) || delivery.disposition === "session_queued") {
      return false;
    }
    if (
      delivery.disposition === "retryable" &&
      state.status === "pending" &&
      !dispatchAccepted &&
      !controllerInput?.custody.rpcAdopted
    ) {
      // No turn accepted this attempt. Preserve the obligation for the next recovery sweep;
      // a restored dispatching receipt remains uncertain and never authorizes this retry.
      await params.transitionBatch(settledBatch, state, refreshBatch);
      return false;
    }
    const retryState = resolveRequesterSettleRetryState({
      state: dispatchState,
      delivery,
      attemptCount,
      parentOnly,
      now: Date.now(),
    });
    if (!retryState) {
      await completeBatch(settledBatch, state, delivery, requesterEntry.sessionId);
      return false;
    }
    await params.transitionBatch(settledBatch, retryState, refreshBatch);
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
