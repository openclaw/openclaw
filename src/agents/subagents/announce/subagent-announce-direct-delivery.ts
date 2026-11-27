import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import { resolveQueueSettings } from "../../../auto-reply/reply/queue.js";
import { runOutsideAdmittedTurnScopes } from "../../../auto-reply/reply/queue/drain-admission-scope.js";
import { getRuntimeConfig as getSubagentAnnounceRuntimeConfig } from "../../../config/config.js";
import { bindInProcessSessionRun } from "../../../gateway/in-process-session-run.js";
import { resolveExternalBestEffortDeliveryTarget } from "../../../infra/outbound/best-effort-delivery.js";
import { stringifyRouteThreadId } from "../../../plugin-sdk/channel-route.js";
import { getPluginRuntimeGatewayRequestScope } from "../../../plugins/runtime/gateway-request-scope.js";
import {
  INTERNAL_PROVENANCE_SOURCE_CHANNEL,
  isAgentMediatedCompletionSourceTool,
} from "../../../sessions/input-provenance.js";
import { waitForReplyOperationBackend } from "../../../sessions/session-controller.state.js";
import {
  submitSessionControllerSteer,
  type SessionControllerSteerResult,
} from "../../../sessions/session-controller.steer.js";
import { isCronRunSessionKey } from "../../../sessions/session-key-utils.js";
import { sessionDeliveryChannel } from "../../../utils/delivery-context.read.js";
import {
  isGatewayMessageChannel,
  normalizeMessageChannel,
} from "../../../utils/message-channel.js";
import {
  isEmbeddedAgentRunHandleActive,
  resolveEmbeddedRunAbandonment,
} from "../../embedded-agent-runner/runs.js";
import { buildAgentInternalEventContext } from "../../internal-events.js";
import {
  RUNTIME_EVENT_USER_PROMPT,
  projectRuntimeContextFragments,
} from "../../internal-runtime-context.js";
import {
  resolveCommandReplyExpectation,
  resolveCompletionInputReplyExpectation,
} from "../../reply-completion.js";
import { readRetainedRequesterToolCaller } from "../../tools/gateway-caller-context.js";
import {
  deliverCompletionDirect,
  runAnnounceAgentCall,
} from "./subagent-announce-completion-delivery.js";
import {
  hasAnnounceSendEvidence,
  resolveSubagentAnnounceTimeoutMs,
  SourceOwnerChangedError,
  summarizeDeliveryError,
} from "./subagent-announce-delivery-retry.js";
import {
  getSubagentRequesterSessionActivity as resolveRequesterSessionActivity,
  loadRequesterSessionEntry,
  withSubagentRequesterDelivery,
} from "./subagent-announce-delivery.runtime.js";
import {
  createDirectAnnounceResponseClassifier,
  executeAnnounceResponseDecision,
} from "./subagent-announce-direct-response.js";
import type {
  SubagentAnnounceDeliveryResult,
  SubagentAnnounceDirectParams,
} from "./subagent-announce-dispatch.js";
import {
  planDirectAnnounceDelivery,
  resolveFailedAnnounceResponse,
} from "./subagent-announce-obligation.js";
import { resolveCompletionDeliveryOrigins } from "./subagent-announce-origin.js";
import { resolveRequesterStoreKey } from "./subagent-requester-store-key.js";

/** Another owner (a yielded requester or an idle cron turn) settles this completion. */
function completionHandoffPendingResult(): SubagentAnnounceDeliveryResult {
  return { delivered: false, path: "none", reason: "completion_handoff_pending" };
}

export async function sendSubagentAnnounceDirectly(
  params: SubagentAnnounceDirectParams,
): Promise<SubagentAnnounceDeliveryResult> {
  return runOutsideAdmittedTurnScopes(() =>
    withSubagentRequesterDelivery(
      params.targetRequesterSessionKey,
      params,
      sendSubagentAnnounceDirectlyBound,
    ),
  );
}

async function sendSubagentAnnounceDirectlyBound(
  params: Parameters<typeof sendSubagentAnnounceDirectly>[0],
): ReturnType<typeof sendSubagentAnnounceDirectly> {
  if (params.signal?.aborted) {
    return { delivered: false, path: "none", error: summarizeDeliveryError(params.signal.reason) };
  }
  const parentOnly = params.completionTarget === "parent";
  const sourceToolId =
    normalizeOptionalLowercaseString(params.sourceTool) ??
    (params.expectsCompletionMessage ? "subagent_announce" : "");
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
    const requesterAgentId = requester.agentId;
    const operatorAuthority =
      getPluginRuntimeGatewayRequestScope()?.client?.internal?.operatorRunAuthority;
    const participating = operatorAuthority?.participationCeiling !== undefined;
    if (participating) {
      operatorAuthority.signal?.throwIfAborted();
    }
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
    const {
      isSubagentCompletion,
      trustedCompletionEvent,
      hasRequiredSubagentNoOutputCompletion,
      hasSuccessfulTrustedSubagentNoOutputCompletion,
      subagentDirectMessageCompletionRequiresMessageTool,
      requiresMessageToolDelivery,
      completionSourceReplyDeliveryMode,
      shouldDeliverAgentFinal,
    } = planDirectAnnounceDelivery(params, {
      cfg,
      sourceToolId,
      canonicalRequesterSessionKey,
      requesterEntry,
      requesterSessionOrigin,
      effectiveDirectOrigin,
      deliveryTarget,
      participating,
    });
    const agentMediatedCompletion =
      params.expectsCompletionMessage && isAgentMediatedCompletionSourceTool(sourceToolId);
    const requesterActivity = resolveRequesterSessionActivity(
      params.targetRequesterSessionKey,
      requester,
    );
    // Settlement and private findings go to the requester chat, also after a reset or a
    // compaction successor, including a visible continuation after the spawning turn yielded.
    const requesterSessionBound =
      parentOnly || sourceToolId === "subagent_settle" || agentMediatedCompletion;
    if (requesterSessionBound && !requesterActivity.sessionId) {
      return {
        delivered: false,
        path: "none",
        reason: "completion_handoff_unavailable",
        error: "completion requester session is unavailable",
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
    const tryTextCompletionDirectDelivery = (agentResult?: { payloads?: unknown }) => {
      return deliverCompletionDirect({
        cfg,
        requesterSessionKey: canonicalRequesterSessionKey,
        requesterSessionId,
        requesterAgentId: params.requesterAgentId,
        directIdempotencyKey: params.directIdempotencyKey,
        deliveryTarget,
        internalEvents: params.internalEvents,
        agentResult,
        signal: params.signal,
        onDeliveryResult: params.onDeliveryResult,
        onDeliveryError: params.onDeliveryError,
        isSourceSessionEffectsAllowed: isCompletionDeliveryAllowed,
      });
    };
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
      !participating &&
      !parentOnly &&
      !params.requireDirectDelivery &&
      params.expectsCompletionMessage &&
      params.controllerInput
    ) {
      let steer: SessionControllerSteerResult;
      try {
        // Recovery owns the turn before its backend is ready. Queuing behind it can
        // deadlock a parent waiting for this result; steering resolves its live owner below.
        const requesterOperation = params.controllerInput.mailbox.owner.active;
        if (requesterOperation) {
          await waitForReplyOperationBackend(
            requesterOperation,
            params.signal
              ? AbortSignal.any([params.signal, params.controllerInput.abortSignal])
              : params.controllerInput.abortSignal,
          );
        }
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
          return { delivered: false, path: "none", reason: "source_owner_changed" };
        }
        throw error;
      }
      // A committed steer delivered the result; a later owner change cannot undo that.
      if (steer.status === "accepted") {
        return { delivered: true, path: "steered" };
      }
      // Otherwise steering consumed admission; its outcome counts while the owner is current.
      if (!isCompletionDeliveryAllowed()) {
        return { delivered: false, path: "none", reason: "source_owner_changed" };
      }
      if (steer.status === "indeterminate") {
        // The input was consumed without a confirmed commit; it is never replayed.
        return { delivered: false, path: "steered", error: steer.errorMessage };
      }
      if (!isCompletionAdmissionAllowed()) {
        return { delivered: false, path: "none", reason: "source_owner_changed" };
      }
    }
    // A cron run keeps its session turn through finalization, so a requester turn queued
    // after its agent attempt ended would wait out the run; the run reads this row itself.
    if (
      params.expectsCompletionMessage &&
      isCronRunSessionKey(canonicalRequesterSessionKey) &&
      !agentMediatedCompletion
    ) {
      const { sessionId } = resolveRequesterSessionActivity(
        params.targetRequesterSessionKey,
        await loadRequesterSessionEntry(params.targetRequesterSessionKey, params.requesterAgentId),
      );
      if (!sessionId || !isEmbeddedAgentRunHandleActive(sessionId)) {
        return completionHandoffPendingResult();
      }
    }
    if (params.signal?.aborted) {
      return {
        delivered: false,
        path: "none",
        error: summarizeDeliveryError(params.signal.reason),
      };
    }
    const directAgentOrigin = shouldDeliverAgentFinal
      ? deliveryTarget
      : sessionOnlyOriginChannel
        ? sessionOnlyOrigin
        : undefined;
    const inputReplyExpectation = resolveCompletionInputReplyExpectation(sourceToolId, params);
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
      sessionKey: canonicalRequesterSessionKey,
      ...(requesterAgentId ? { agentId: requesterAgentId } : {}),
      message: turnMessage,
      deliver: shouldDeliverAgentFinal,
      bestEffortDeliver: params.bestEffortDeliver,
      internalEvents: params.internalEvents,
      channel: shouldDeliverAgentFinal ? deliveryTarget.channel : sessionOnlyOriginChannel,
      ...(params.inputAttachments?.length ? { attachments: params.inputAttachments } : {}),
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
    // Completions bind the current requester chat, including a nested fallback.
    const boundRequesterSessionId = requesterSessionBound
      ? requesterActivity.sessionId
      : isSubagentCompletion
        ? requesterSessionId
        : undefined;
    if (boundRequesterSessionId) {
      directAgentParams = bindInProcessSessionRun(directAgentParams, {
        sessionKey: canonicalRequesterSessionKey,
        sessionId: boundRequesterSessionId,
        lifecycleRevision: requesterLifecycleRevision ?? null,
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
      tryTextCompletionDirectDelivery,
    });
    let directAnnounceResponse: unknown;
    let directFailure: SubagentAnnounceDeliveryResult | undefined;
    try {
      if (!isCompletionAdmissionAllowed()) {
        throw new SourceOwnerChangedError();
      }
      directAnnounceResponse = await runAnnounceAgentCall({
        agentToolCaller: readRetainedRequesterToolCaller(),
        agentParams: directAgentParams,
        subagentCompletions: params.subagentCompletions,
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
      if (!isCompletionDeliveryAllowed()) {
        return { delivered: false, path: "none", reason: "source_owner_changed" };
      }
    } catch (err) {
      if (!dispatchPrepared) {
        throw err;
      }
      if (err instanceof SourceOwnerChangedError) {
        return { delivered: false, path: "none", reason: "source_owner_changed" };
      }
      if (hasAnnounceSendEvidence(err)) {
        throw err;
      }
      const decision = resolveFailedAnnounceResponse(
        {
          params,
          shouldDeliverAgentFinal,
          subagentDirectMessageCompletionRequiresMessageTool,
          isSubagentCompletion,
        },
        err,
      );
      directFailure = await executeAnnounceResponseDecision(
        decision,
        tryTextCompletionDirectDelivery,
      );
      if (!("action" in decision) || directFailure === decision.unavailable) {
        params.onDeliveryError?.(err);
      }
    }

    const classified = directFailure ?? classifyResponse(directAnnounceResponse);
    return classified instanceof Promise ? await classified : classified;
  } catch (err) {
    // A failed dispatch receipt has not admitted any delivery; its owner retries preparation.
    if (!dispatchPrepared) {
      throw err;
    }
    params.onDeliveryError?.(err);
    return { delivered: false, path: "direct", error: summarizeDeliveryError(err) };
  }
}
