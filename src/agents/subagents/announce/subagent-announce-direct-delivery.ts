import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import { completionRequiresMessageToolDelivery } from "../../../auto-reply/reply/completion-delivery-policy.js";
import type { RestartRecoveryTerminalDeliveryEvidence } from "../../../config/sessions/restart-recovery-types.js";
import { readSessionEntriesFromStoreInWorker } from "../../../config/sessions/session-entry-read-runtime.js";
import { bindInProcessSessionRun } from "../../../gateway/in-process-session-run.js";
import { stringifyRouteThreadId } from "../../../plugin-sdk/channel-route.js";
import { defaultRuntime } from "../../../runtime.js";
import {
  INTERNAL_PROVENANCE_SOURCE_CHANNEL,
  isAgentMediatedCompletionSourceTool,
} from "../../../sessions/input-provenance.js";
import {
  submitSessionControllerSteer,
  type SessionControllerSteerResult,
} from "../../../sessions/session-controller.steer.js";
import { isCronRunSessionKey } from "../../../sessions/session-key-utils.js";
import { isIncognitoSessionKey } from "../../../shared/incognito-session-key.js";
import { isIncognitoOpenClawAgentSqlitePath } from "../../../state/openclaw-agent-db.paths.js";
import { sessionDeliveryChannel } from "../../../utils/delivery-context.read.js";
import {
  isGatewayMessageChannel,
  normalizeMessageChannel,
} from "../../../utils/message-channel.js";
import {
  buildAgentRunTerminalOutcomeFromWaitResult,
  classifyAgentRunTerminalOutcome,
} from "../../agent-run-terminal-outcome.js";
import { resolveEmbeddedRunAbandonment } from "../../embedded-agent-runner/runs.js";
import { isReplaySafeTranscriptConflict } from "../../embedded-agent-runner/transcript-conflict.js";
import {
  hasFailedSubagentNoOutputCompletion,
  hasVisibleCompletionResult,
} from "../../internal-event-contract.js";
import { buildAgentInternalEventContext } from "../../internal-events.js";
import {
  RUNTIME_EVENT_USER_PROMPT,
  projectRuntimeContextFragments,
} from "../../internal-runtime-context.js";
import { resolveCommandReplyExpectation } from "../../reply-completion.js";
import {
  deliverCompletionDirect,
  isDirectMessageDeliveryTarget,
  resolveRequesterRecoveryDelivery,
  runAnnounceAgentCall,
} from "./subagent-announce-completion-delivery.js";
import {
  hasAnnounceSendEvidence,
  isIncompleteAnnounceAgentResultError,
  isPermanentAnnounceDeliveryError,
  resolveSubagentAnnounceTimeoutMs,
  SourceOwnerChangedError,
  summarizeDeliveryError,
} from "./subagent-announce-delivery-retry.js";
import {
  getSubagentAnnounceRuntimeConfig,
  getSubagentRequesterSessionActivity as resolveRequesterSessionActivity,
  loadRequesterSessionEntry,
  resolveExternalBestEffortDeliveryTarget,
  resolveQueueSettings,
  withSubagentRequesterDelivery,
} from "./subagent-announce-delivery.runtime.js";
import { createDirectAnnounceResponseClassifier } from "./subagent-announce-direct-response.js";
import {
  sourceOwnerChangedResult,
  type SubagentAnnounceDeliveryResult,
  type SubagentAnnounceDirectParams,
} from "./subagent-announce-dispatch.js";
import { resolveExactSubagentCompletionEvent } from "./subagent-announce-handoff.js";
import { resolveCompletionDeliveryOrigins } from "./subagent-announce-origin.js";
import { resolveRequesterStoreKey } from "./subagent-requester-store-key.js";

/** Another owner (a yielded requester or an idle cron turn) settles this completion. */
function completionHandoffPendingResult(): SubagentAnnounceDeliveryResult {
  return {
    delivered: false,
    path: "none",
    reason: "completion_handoff_pending",
    terminal: true,
    disposition: "intentional_non_delivery",
  };
}

export async function sendSubagentAnnounceDirectly(
  params: SubagentAnnounceDirectParams,
): Promise<SubagentAnnounceDeliveryResult> {
  return withSubagentRequesterDelivery(
    params.targetRequesterSessionKey,
    params,
    sendSubagentAnnounceDirectlyBound,
  );
}

async function sendSubagentAnnounceDirectlyBound(
  params: Parameters<typeof sendSubagentAnnounceDirectly>[0],
): ReturnType<typeof sendSubagentAnnounceDirectly> {
  if (params.signal?.aborted) {
    return { delivered: false, path: "none" };
  }
  const parentOnly = params.completionTarget === "parent";
  const cfg = getSubagentAnnounceRuntimeConfig();
  const announceTimeoutMs = resolveSubagentAnnounceTimeoutMs(cfg);
  const runtimeContextFragments = buildAgentInternalEventContext(params.internalEvents);
  const turnMessage = runtimeContextFragments.length
    ? RUNTIME_EVENT_USER_PROMPT
    : params.triggerMessage;
  let dispatchPrepared = params.onBeforeDispatch === undefined;
  const canonicalRequesterSessionKey = resolveRequesterStoreKey(
    cfg,
    params.targetRequesterSessionKey,
    params.requesterAgentId,
  );
  try {
    // A partial completion origin must retain the target from the requester's
    // recorded delivery context or the generated reply becomes undeliverable.
    const { requesterSessionOrigin, effectiveDirectOrigin } =
      resolveCompletionDeliveryOrigins(params);
    const sessionOnlyOrigin = effectiveDirectOrigin?.channel
      ? effectiveDirectOrigin
      : requesterSessionOrigin;
    const requester = await loadRequesterSessionEntry(
      params.targetRequesterSessionKey,
      params.requesterAgentId,
    );
    const requesterEntry = requester.entry;
    const requesterCanonicalKey = requester.canonicalKey;
    const requesterAgentId = requester.agentId;
    const requesterStorePath = requester.storePath;
    const requesterSessionId = requesterEntry?.sessionId;
    const requesterLifecycleRevision = requesterEntry?.lifecycleRevision;
    const deliveryTarget =
      !parentOnly && !params.requesterIsSubagent
        ? resolveExternalBestEffortDeliveryTarget(effectiveDirectOrigin ?? {})
        : { deliver: false };
    const normalizedSessionOnlyOriginChannel = !params.requesterIsSubagent
      ? normalizeMessageChannel(sessionOnlyOrigin?.channel)
      : undefined;
    const sessionOnlyOriginChannel =
      normalizedSessionOnlyOriginChannel &&
      isGatewayMessageChannel(normalizedSessionOnlyOriginChannel)
        ? normalizedSessionOnlyOriginChannel
        : undefined;
    const sourceToolId =
      normalizeOptionalLowercaseString(params.sourceTool) ??
      (params.expectsCompletionMessage ? "subagent_announce" : "");
    if (
      params.recoveryReceiptOnly &&
      (parentOnly ||
        params.expectsCompletionMessage ||
        sourceToolId !== "subagent_settle" ||
        !params.completionRequesterSessionId)
    ) {
      return sourceOwnerChangedResult();
    }
    const isSubagentCompletion = sourceToolId === "subagent_announce";
    const trustedCompletionEvent = resolveExactSubagentCompletionEvent({
      inputProvenance: {
        kind: "inter_session",
        sourceSessionKey: params.sourceSessionKey,
        sourceTool: sourceToolId,
      },
      internalEvents: params.internalEvents,
    });
    const hasFailedTrustedSubagentCompletion =
      trustedCompletionEvent !== undefined && trustedCompletionEvent.status !== "ok";
    const hasRequiredSubagentNoOutputCompletion =
      params.expectsCompletionMessage &&
      isSubagentCompletion &&
      ((trustedCompletionEvent !== undefined &&
        !hasVisibleCompletionResult(trustedCompletionEvent)) ||
        hasFailedSubagentNoOutputCompletion(params.internalEvents));
    const hasSuccessfulTrustedSubagentNoOutputCompletion =
      hasRequiredSubagentNoOutputCompletion && trustedCompletionEvent?.status === "ok";
    const textCompletionDirectDeliveryKind = hasFailedTrustedSubagentCompletion
      ? "failed_notice"
      : "completed_result";
    const agentMediatedCompletion =
      params.expectsCompletionMessage && isAgentMediatedCompletionSourceTool(sourceToolId);
    const completionRouteRequiresMessageToolDelivery =
      !parentOnly &&
      params.expectsCompletionMessage &&
      completionRequiresMessageToolDelivery({
        cfg,
        requesterSessionKey: params.requesterSessionKey,
        targetRequesterSessionKey: canonicalRequesterSessionKey,
        requesterEntry,
        directOrigin: effectiveDirectOrigin,
        requesterSessionOrigin,
      });
    const subagentDirectMessageCompletionRequiresMessageTool =
      params.expectsCompletionMessage &&
      isSubagentCompletion &&
      deliveryTarget.deliver &&
      isDirectMessageDeliveryTarget(deliveryTarget, canonicalRequesterSessionKey);
    const requiresMessageToolDelivery =
      completionRouteRequiresMessageToolDelivery ||
      subagentDirectMessageCompletionRequiresMessageTool;
    const requesterActivity = resolveRequesterSessionActivity(
      params.targetRequesterSessionKey,
      requester,
    );
    // Settlement and private findings bind to the captured requester incarnation,
    // including a visible continuation after the spawning turn has yielded.
    const requesterSessionBound =
      parentOnly ||
      (sourceToolId === "subagent_settle" && params.completionRequesterSessionId !== undefined);
    if (
      requesterSessionBound &&
      (!params.completionRequesterSessionId ||
        requesterActivity.sessionId !== params.completionRequesterSessionId ||
        requesterEntry?.lifecycleRevision !== params.completionRequesterLifecycleRevision)
    ) {
      return {
        delivered: false,
        path: "none",
        reason: "completion_handoff_unavailable",
        error: "completion requester session is unavailable or replaced",
        terminal: true,
        disposition: "intentional_non_delivery",
      };
    }
    const requesterAbandonment = params.expectsCompletionMessage
      ? resolveEmbeddedRunAbandonment({
          sessionKey: canonicalRequesterSessionKey,
          sessionId: requesterActivity.sessionId,
          target: requesterActivity.target,
        })
      : undefined;
    if (requesterAbandonment === "timeout") {
      return {
        delivered: false,
        path: "none",
        reason: "requester_abandoned",
        error: "requester session abandoned after timeout",
      };
    }
    const isCompletionDeliveryAllowed = () =>
      params.isSourceSessionEffectsAllowed?.() !== false &&
      !(params.expectsCompletionMessage && params.isCompletionOwnedByRequesterYield?.());
    const isCompletionAdmissionAllowed = () =>
      isCompletionDeliveryAllowed() && params.isSourceSessionAdmissionAllowed?.() !== false;
    if (!isCompletionAdmissionAllowed()) {
      // sessions_yield owns the post-turn synthesis. Starting or steering a
      // requester turn here would replay the original fanout during handoff.
      return completionHandoffPendingResult();
    }
    const resolveRecovery = async (
      entry: typeof requesterEntry,
      replaySafeTranscriptConflict = false,
    ) => {
      const recovery = resolveRequesterRecoveryDelivery(
        entry,
        params.directIdempotencyKey,
        replaySafeTranscriptConflict,
      );
      if (
        parentOnly &&
        recovery?.kind === "delivery" &&
        recovery.delivery.reason === "requester_turn_pending"
      ) {
        const { resolvePrivateRequesterSettleRecoveryOwner } =
          await import("../registry/subagent-registry-restart-recovery.js");
        // This private owner must finish its own interrupted input, not wait for itself.
        if (
          resolvePrivateRequesterSettleRecoveryOwner(
            { ...requester, entry },
            params.directIdempotencyKey,
          ) === "owned"
        ) {
          return undefined;
        }
      }
      return recovery;
    };
    // A recovered requester already owns this admitted input. Reuse its final
    // receipt through the normal delivery checks; never execute the old wake again.
    const recovery =
      sourceToolId === "subagent_settle" || isSubagentCompletion
        ? await resolveRecovery(requesterEntry)
        : undefined;
    if (recovery?.kind === "delivery") {
      return recovery.delivery;
    }
    const recoveredResult = recovery?.result;
    if (params.recoveryReceiptOnly && !recoveredResult) {
      return sourceOwnerChangedResult();
    }
    const tryTextCompletionDirectDelivery = (
      contentKind: "completed_result" | "failed_notice" = textCompletionDirectDeliveryKind,
      agentResult?: { payloads?: unknown },
    ) => {
      if (params.recoveryReceiptOnly) {
        return Promise.resolve(undefined);
      }
      return deliverCompletionDirect({
        cfg,
        requesterSessionKey: canonicalRequesterSessionKey,
        requesterSessionId,
        requesterAgentId: params.requesterAgentId,
        directIdempotencyKey: params.directIdempotencyKey,
        deliveryTarget,
        internalEvents: params.internalEvents,
        contentKind,
        agentResult,
        signal: params.signal,
        onDeliveryResult: params.onDeliveryResult,
        onDeliveryError: params.onDeliveryError,
        isSourceSessionEffectsAllowed: isCompletionDeliveryAllowed,
      });
    };
    // A private settle turn never delivers; automatic only keeps a tool-only mode from
    // suppressing its internal final. A deliverable yielded turn omits the mode so the
    // conversation's configured reply policy decides, as for any other requester turn.
    const completionSourceReplyDeliveryMode = parentOnly
      ? "automatic"
      : requiresMessageToolDelivery
        ? "message_tool_only"
        : undefined;
    const shouldDeliverAgentFinal = deliveryTarget.deliver && !requiresMessageToolDelivery;
    const requesterQueueSettings = resolveQueueSettings({
      cfg,
      channel:
        sessionDeliveryChannel(requesterEntry) ??
        requesterSessionOrigin?.channel ??
        params.directOrigin?.channel,
      sessionEntry: requesterEntry,
    });
    // A public completion steers once into the requester's running turn. Ordinary
    // rejection leaves its input queued for the dispatch below.
    if (
      !recoveredResult &&
      !parentOnly &&
      !params.requireDirectDelivery &&
      params.expectsCompletionMessage &&
      params.controllerInput
    ) {
      let steer: SessionControllerSteerResult;
      try {
        steer = await submitSessionControllerSteer({
          input: params.controllerInput,
          text: turnMessage,
          // A completion must never abort its requester over an unconfirmed commit.
          abortOnUnconfirmedTranscript: false,
          options: {
            deliveryTimeoutMs: announceTimeoutMs,
            steeringMode: "all",
            ...(completionSourceReplyDeliveryMode
              ? { sourceReplyDeliveryMode: completionSourceReplyDeliveryMode }
              : {}),
            // Subagent inputs ignore the session queue mode except its debounce.
            ...(requesterQueueSettings.debounceMs !== undefined
              ? { debounceMs: requesterQueueSettings.debounceMs }
              : {}),
            waitForTranscriptCommit: true,
            ...(runtimeContextFragments.length
              ? {
                  currentInboundContext: {
                    text: projectRuntimeContextFragments(runtimeContextFragments),
                    fragments: runtimeContextFragments,
                  },
                }
              : {}),
            ...(params.createUserTurnTranscriptRecorder && requesterActivity.sessionId
              ? {
                  userTurnTranscriptRecorder: params.createUserTurnTranscriptRecorder(
                    requesterActivity.sessionId,
                  ),
                }
              : {}),
            assertCurrent: () => {
              if (!isCompletionAdmissionAllowed()) {
                throw new SourceOwnerChangedError();
              }
            },
          },
        });
      } catch (error) {
        if (error instanceof SourceOwnerChangedError) {
          return sourceOwnerChangedResult();
        }
        throw error;
      }
      // Steering consumes admission; its result remains valid while the delivery owner is current.
      if (!isCompletionDeliveryAllowed()) {
        return sourceOwnerChangedResult();
      }
      if (steer.status === "accepted") {
        return { delivered: true, path: "steered" };
      }
      if (steer.status === "indeterminate") {
        // The input was consumed without a confirmed commit; it is never replayed.
        return {
          delivered: false,
          path: "steered",
          error: steer.errorMessage,
          disposition: "ambiguous",
        };
      }
      if (!isCompletionAdmissionAllowed()) {
        return sourceOwnerChangedResult();
      }
    }
    if (
      params.expectsCompletionMessage &&
      isCronRunSessionKey(canonicalRequesterSessionKey) &&
      !resolveRequesterSessionActivity(
        params.targetRequesterSessionKey,
        await loadRequesterSessionEntry(params.targetRequesterSessionKey, params.requesterAgentId),
      ).isActive &&
      !agentMediatedCompletion
    ) {
      return completionHandoffPendingResult();
    }
    if (params.signal?.aborted) {
      return { delivered: false, path: "none" };
    }
    const directAgentOrigin = shouldDeliverAgentFinal
      ? deliveryTarget
      : sessionOnlyOriginChannel
        ? sessionOnlyOrigin
        : undefined;
    const inputReplyExpectation =
      params.expectsCompletionMessage || params.requireVisibleReply ? "required" : "optional";
    // Settle execution and receipt classification share the owner's reply obligation.
    const replyExpectation =
      sourceToolId === "subagent_settle"
        ? inputReplyExpectation
        : resolveCommandReplyExpectation({
            cfg,
            sessionKey: canonicalRequesterSessionKey,
            sessionEntry: requesterEntry,
            messageChannel: shouldDeliverAgentFinal
              ? deliveryTarget.channel
              : sessionOnlyOriginChannel,
            opts: {
              ...(parentOnly ? { privateCompletion: true as const } : {}),
              inputProvenance: { kind: "inter_session" },
            },
          });
    // A private completion gets its own serialized turn. Steering into a public
    // turn would inherit that turn's delivery policy and expose child output.
    let directAgentParams: Record<string, unknown> = {
      ...(requesterSessionBound
        ? {
            expectedExistingSessionId: params.completionRequesterSessionId,
            expectedExistingSessionLifecycleRevision:
              params.completionRequesterLifecycleRevision ?? null,
          }
        : {}),
      sessionKey: canonicalRequesterSessionKey,
      ...(requesterAgentId ? { agentId: requesterAgentId } : {}),
      message: turnMessage,
      deliver: shouldDeliverAgentFinal,
      bestEffortDeliver: params.bestEffortDeliver,
      internalEvents: params.internalEvents,
      channel: shouldDeliverAgentFinal ? deliveryTarget.channel : sessionOnlyOriginChannel,
      accountId: directAgentOrigin?.accountId,
      to: directAgentOrigin?.to,
      threadId: stringifyRouteThreadId(directAgentOrigin?.threadId),
      inputProvenance: {
        kind: "inter_session",
        sourceSessionKey: params.sourceSessionKey,
        sourceChannel: INTERNAL_PROVENANCE_SOURCE_CHANNEL,
        sourceTool: params.sourceTool ?? "subagent_announce",
      },
      ...(completionSourceReplyDeliveryMode
        ? { sourceReplyDeliveryMode: completionSourceReplyDeliveryMode }
        : {}),
      idempotencyKey: params.directIdempotencyKey,
    };
    if (requesterSessionBound && params.completionRequesterSessionId) {
      directAgentParams = bindInProcessSessionRun(directAgentParams, {
        sessionKey: canonicalRequesterSessionKey,
        sessionId: params.completionRequesterSessionId,
        lifecycleRevision: params.completionRequesterLifecycleRevision ?? null,
        runId: params.directIdempotencyKey,
      });
    }
    const classifyResponse = createDirectAnnounceResponseClassifier({
      params,
      parentOnly,
      requesterSessionBound,
      replyExpectation,
      deliveryTarget,
      shouldDeliverAgentFinal,
      requiresMessageToolDelivery,
      isSubagentCompletion,
      hasSuccessfulTrustedSubagentNoOutputCompletion,
      hasRequiredSubagentNoOutputCompletion,
      subagentDirectMessageCompletionRequiresMessageTool,
      effectiveDirectOrigin,
      requesterSessionOrigin,
      textCompletionDirectDeliveryKind,
      tryTextCompletionDirectDelivery,
    });
    const classifyRecoveredResult = (result: RestartRecoveryTerminalDeliveryEvidence) => {
      if (parentOnly && (!result.captured || result.meta?.error || result.meta?.aborted)) {
        return {
          delivered: false,
          path: "direct",
          reason: "completion_handoff_pending",
          error: "recovered private requester did not complete successfully",
          disposition: "permanent_failure",
        } satisfies SubagentAnnounceDeliveryResult;
      }
      // Recovery processed the same private input. Its retained result replaces
      // the original RPC receipt without admitting that terminal run again.
      return classifyResponse({
        status: "ok",
        result,
        ...(parentOnly ? { inputProcessingCompleted: true } : {}),
      });
    };
    let directAnnounceResponse: unknown;
    let directFailure: SubagentAnnounceDeliveryResult | undefined;
    let replaySafeTranscriptConflict = false;
    try {
      directAnnounceResponse = recoveredResult
        ? { status: "ok", result: recoveredResult }
        : await (async () => {
            // One dispatch; its outcome is recorded once and never replayed.
            if (!isCompletionAdmissionAllowed()) {
              throw new SourceOwnerChangedError();
            }
            return await runAnnounceAgentCall({
              agentParams: directAgentParams,
              controllerInput: params.controllerInput,
              replyExpectation: inputReplyExpectation,
              // A resumed parent has no inbound channel dispatcher to keep activity visible.
              typing:
                sourceToolId === "subagent_settle" &&
                shouldDeliverAgentFinal &&
                deliveryTarget.channel &&
                deliveryTarget.to
                  ? {
                      agentId: requesterAgentId,
                      runId: params.directIdempotencyKey,
                      channel: deliveryTarget.channel,
                      to: deliveryTarget.to,
                      accountId: deliveryTarget.accountId,
                      threadId: deliveryTarget.threadId,
                    }
                  : undefined,
              settleWakeSourceSessionKeys: params.settleWakeSourceSessionKeys,
              ...(parentOnly ? { privateCompletion: true as const } : {}),
              delegatedToolPolicyHandoff:
                ((isSubagentCompletion && trustedCompletionEvent) ||
                  (sourceToolId === "subagent_settle" &&
                    params.settleWakeSourceSessionKeys?.length &&
                    params.isSourceSessionEffectsAllowed)) &&
                params.sourceSessionKey &&
                requesterActivity.sessionId &&
                params.isSourceSessionEffectsAllowed?.() !== false
                  ? {
                      sourceSessionKey: params.sourceSessionKey,
                      ...(trustedCompletionEvent?.childSessionId
                        ? { sourceSessionId: trustedCompletionEvent.childSessionId }
                        : {}),
                      targetSessionKey: canonicalRequesterSessionKey,
                      targetSessionId: requesterActivity.sessionId,
                      idempotencyKey: params.directIdempotencyKey,
                      ...(sourceToolId === "subagent_settle" && params.settleWakeSourceSessionKeys
                        ? {
                            settleBatch: {
                              sourceSessionKeys: params.settleWakeSourceSessionKeys,
                              isCurrent: isCompletionDeliveryAllowed,
                              receiptAdmission: params.sourceReceiptAdmission,
                            },
                          }
                        : {}),
                    }
                  : undefined,
              expectFinal: true,
              signal: params.signal,
              onAccepted: params.onAccepted,
              onExecutionStarted: params.onExecutionStarted,
              onBeforeDispatch: params.onBeforeDispatch
                ? async () => {
                    await params.onBeforeDispatch!();
                    dispatchPrepared = true;
                  }
                : undefined,
              // Private delivery waits in the requester mailbox without an admission deadline.
              timeoutMs: parentOnly && isSubagentCompletion ? undefined : announceTimeoutMs,
              isExecutionAllowed: isCompletionDeliveryAllowed,
              isSourceSessionAdmissionAllowed:
                params.isSourceSessionAdmissionAllowed && isCompletionAdmissionAllowed,
              resolveGatewayContext: params.resolveGatewayContext,
            });
          })();
      if (!isCompletionDeliveryAllowed()) {
        return sourceOwnerChangedResult();
      }
    } catch (err) {
      if (!dispatchPrepared) {
        throw err;
      }
      if (err instanceof SourceOwnerChangedError) {
        return sourceOwnerChangedResult();
      }
      if (hasAnnounceSendEvidence(err)) {
        throw err;
      }
      if (params.signal?.aborted) {
        return { delivered: false, path: "none" };
      }
      const directCompletionFallbackKind = hasFailedTrustedSubagentCompletion
        ? "failed_notice"
        : isIncompleteAnnounceAgentResultError(err)
          ? "completed_result"
          : undefined;
      if (
        params.expectsCompletionMessage &&
        (shouldDeliverAgentFinal || subagentDirectMessageCompletionRequiresMessageTool) &&
        isSubagentCompletion &&
        directCompletionFallbackKind
      ) {
        const textDelivery = await tryTextCompletionDirectDelivery(directCompletionFallbackKind);
        if (textDelivery) {
          return textDelivery;
        }
      }
      params.onDeliveryError?.(err);
      replaySafeTranscriptConflict =
        sourceToolId === "subagent_settle" && isReplaySafeTranscriptConflict(err);
      directFailure = {
        delivered: false,
        path: "direct",
        error: summarizeDeliveryError(err),
        disposition: isPermanentAnnounceDeliveryError(err) ? "permanent_failure" : "retryable",
      };
    }

    const classified =
      directFailure ??
      (recoveredResult
        ? classifyRecoveredResult(recoveredResult)
        : classifyResponse(directAnnounceResponse));
    const delivery = classified instanceof Promise ? await classified : classified;
    const originalOutcome = buildAgentRunTerminalOutcomeFromWaitResult(
      asOptionalRecord(directAnnounceResponse),
    );
    if (
      (sourceToolId !== "subagent_settle" && !isSubagentCompletion) ||
      recoveredResult !== undefined ||
      requesterCanonicalKey !== canonicalRequesterSessionKey ||
      !requesterAgentId ||
      !requesterStorePath ||
      !requesterSessionId ||
      !params.isSourceSessionEffectsAllowed ||
      isIncognitoSessionKey(canonicalRequesterSessionKey) ||
      isIncognitoOpenClawAgentSqlitePath(requesterStorePath, { agentId: requesterAgentId }) ||
      (originalOutcome &&
        classifyAgentRunTerminalOutcome(originalOutcome) === "cancellation" &&
        originalOutcome.stopReason !== "restart") ||
      delivery.delivered ||
      delivery.terminal ||
      (delivery.disposition !== undefined && delivery.disposition !== "retryable")
    ) {
      return delivery;
    }
    if (params.signal?.aborted) {
      return { delivered: false, path: "none" };
    }
    if (!isCompletionDeliveryAllowed()) {
      return sourceOwnerChangedResult();
    }
    // Recovery may settle this exact input while its original dispatch awaits.
    // Borrow the existing worker reader only now; the wake caller retains the
    // live requester/store/batch authority and owns any later retry decision.
    let current: Awaited<ReturnType<typeof readSessionEntriesFromStoreInWorker>>;
    try {
      current = await readSessionEntriesFromStoreInWorker({
        agentId: requesterAgentId,
        storePath: requesterStorePath,
        sessionKeys: [canonicalRequesterSessionKey],
        snapshotFields: [],
      });
    } catch (error) {
      if (params.signal?.aborted) {
        return { delivered: false, path: "none" };
      }
      if (!isCompletionDeliveryAllowed()) {
        return sourceOwnerChangedResult();
      }
      // A failed observation cannot turn an existing pending or uncertain
      // outcome into permission to start a fresh requester turn.
      defaultRuntime.log(
        `[warn] Requester recovery receipt could not be read: ${summarizeDeliveryError(error)}`,
      );
      return delivery;
    }
    if (params.signal?.aborted) {
      return { delivered: false, path: "none" };
    }
    if (!isCompletionDeliveryAllowed()) {
      return sourceOwnerChangedResult();
    }
    const currentEntry = current.entries.find(
      ({ sessionKey }) => sessionKey === canonicalRequesterSessionKey,
    )?.entry;
    if (
      currentEntry?.sessionId !== requesterSessionId ||
      currentEntry?.lifecycleRevision !== requesterLifecycleRevision
    ) {
      return delivery;
    }
    const settledRecovery = await resolveRecovery(currentEntry, replaySafeTranscriptConflict);
    if (!settledRecovery) {
      return delivery;
    }
    // Settle responses cannot take the subagent text-send fallback. Reusing
    // their normal receipt classifier never dispatches or sends the input again.
    return settledRecovery.kind === "delivery"
      ? settledRecovery.delivery
      : classifyRecoveredResult(settledRecovery.result);
  } catch (err) {
    // A failed dispatch receipt has not admitted any delivery; its owner retries preparation.
    if (!dispatchPrepared) {
      throw err;
    }
    params.onDeliveryError?.(err);
    const disposition = hasAnnounceSendEvidence(err)
      ? "ambiguous"
      : isPermanentAnnounceDeliveryError(err)
        ? "permanent_failure"
        : "retryable";
    return {
      delivered: false,
      path: "direct",
      error: summarizeDeliveryError(err),
      disposition,
    };
  }
}
