import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import { completionRequiresMessageToolDelivery } from "../../../auto-reply/reply/completion-delivery-policy.js";
import { readSessionEntriesFromStoreInWorker } from "../../../config/sessions/session-entry-read-runtime.js";
import { bindInProcessSessionRun } from "../../../gateway/in-process-session-run.js";
import { stringifyRouteThreadId } from "../../../plugin-sdk/channel-route.js";
import { defaultRuntime } from "../../../runtime.js";
import {
  INTERNAL_PROVENANCE_SOURCE_CHANNEL,
  isAgentMediatedCompletionSourceTool,
} from "../../../sessions/input-provenance.js";
import { isCronRunSessionKey } from "../../../sessions/session-key-utils.js";
import type { UserTurnTranscriptRecorder } from "../../../sessions/user-turn-transcript.types.js";
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
import type { EmbeddedAgentQueueMessageOptions } from "../../embedded-agent-runner/run-state.js";
import {
  formatEmbeddedAgentQueueFailureSummary,
  resolveEmbeddedRunAbandonment,
} from "../../embedded-agent-runner/runs.js";
import {
  hasFailedSubagentNoOutputCompletion,
  hasVisibleCompletionResult,
} from "../../internal-event-contract.js";
import { buildAgentInternalEventContext, type AgentInternalEvent } from "../../internal-events.js";
import {
  RUNTIME_EVENT_USER_PROMPT,
  projectRuntimeContextFragments,
} from "../../internal-runtime-context.js";
import type { GatewayToolCallerReceiptAdmission } from "../../tools/gateway-caller-receipt.types.js";
import {
  SOURCE_OWNER_CHANGED,
  resolveActiveWakeWithRetries,
  resolveRequesterSessionActivity,
} from "./subagent-announce-active-wake.js";
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
  runAnnounceDeliveryWithRetry,
  SourceOwnerChangedError,
  summarizeDeliveryError,
} from "./subagent-announce-delivery-retry.js";
import {
  getSubagentAnnounceRuntimeConfig,
  loadRequesterSessionEntry,
  resolveExternalBestEffortDeliveryTarget,
  resolveQueueSettings,
  withSubagentRequesterSource,
} from "./subagent-announce-delivery.runtime.js";
import { createDirectAnnounceResponseClassifier } from "./subagent-announce-direct-response.js";
import {
  sourceOwnerChangedResult,
  type SubagentAnnounceDeliveryResult,
} from "./subagent-announce-dispatch.js";
import { resolveExactSubagentCompletionEvent } from "./subagent-announce-handoff.js";
import {
  resolveCompletionDeliveryOrigins,
  type DeliveryContext,
} from "./subagent-announce-origin.js";
import { resolveRequesterStoreKey } from "./subagent-requester-store-key.js";

export type SubagentAnnounceDirectParams = {
  requesterSessionKey: string;
  requesterAgentId?: string;
  targetRequesterSessionKey: string;
  triggerMessage: string;
  internalEvents?: AgentInternalEvent[];
  expectsCompletionMessage: boolean;
  completionTarget?: "parent";
  completionRequesterSessionId?: string;
  completionRequesterLifecycleRevision?: string;
  requireVisibleReply?: boolean;
  bestEffortDeliver?: boolean;
  directIdempotencyKey: string;
  completionDirectOrigin?: DeliveryContext;
  directOrigin?: DeliveryContext;
  requesterSessionOrigin?: DeliveryContext;
  sourceSessionKey?: string;
  sourceTool?: string;
  settleWakeSourceSessionKeys?: readonly string[];
  isSourceSessionEffectsAllowed?: () => boolean;
  sourceReceiptAdmission?: GatewayToolCallerReceiptAdmission;
  /** Additional source guard released by the accepting Gateway or injection owner. */
  isSourceSessionAdmissionAllowed?: () => boolean;
  isCompletionOwnedByRequesterYield?: () => boolean;
  requesterIsSubagent: boolean;
  createUserTurnTranscriptRecorder?: (sessionId: string) => UserTurnTranscriptRecorder;
  onDeliveryResult?: (delivery: SubagentAnnounceDeliveryResult) => void | Promise<void>;
  signal?: AbortSignal;
  onExecutionStarted?: () => void;
  resolveGatewayContext?: import("../../../gateway/server-methods/types.js").GatewayContextResolver;
};

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
  return withSubagentRequesterSource(
    params.targetRequesterSessionKey,
    params.requesterAgentId,
    async (
      isRequesterCurrent,
    ): Promise<Awaited<ReturnType<typeof sendSubagentAnnounceDirectly>>> => {
      const guardedParams = isRequesterCurrent
        ? {
            ...params,
            isSourceSessionEffectsAllowed: () =>
              isRequesterCurrent() && params.isSourceSessionEffectsAllowed?.() !== false,
            isSourceSessionAdmissionAllowed: () =>
              isRequesterCurrent() && params.isSourceSessionAdmissionAllowed?.() !== false,
          }
        : params;
      return sendSubagentAnnounceDirectlyBound(guardedParams);
    },
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
  const canonicalRequesterSessionKey = resolveRequesterStoreKey(
    cfg,
    params.targetRequesterSessionKey,
    params.requesterAgentId,
  );
  try {
    // A partial completion origin must retain the target from the requester's
    // recorded delivery context or the generated reply becomes undeliverable.
    const { directOrigin, requesterSessionOrigin, effectiveDirectOrigin } =
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
    // Private findings bind to the requester incarnation that produced them,
    // including a deliverable settle continuation that is no longer parentOnly.
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
        error: "private completion requester session is unavailable or replaced",
        terminal: true,
        disposition: "intentional_non_delivery",
      };
    }
    const requesterAbandonment = params.expectsCompletionMessage
      ? resolveEmbeddedRunAbandonment({
          sessionKey: canonicalRequesterSessionKey,
          sessionId: requesterActivity.sessionId,
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
    if (requesterAbandonment === "recovering_timeout") {
      return {
        delivered: false,
        path: "none",
        reason: "completion_handoff_pending",
        error: "requester timeout recovery is still settling",
        disposition: "retryable",
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
    // A recovered requester already owns this admitted input. Reuse its final
    // receipt through the normal delivery checks; never execute the old wake again.
    const recovery =
      !parentOnly && (sourceToolId === "subagent_settle" || isSubagentCompletion)
        ? resolveRequesterRecoveryDelivery(requesterEntry, params.directIdempotencyKey)
        : undefined;
    if (recovery?.kind === "delivery") {
      return recovery.delivery;
    }
    const recoveredResult = recovery?.result;
    const tryTextCompletionDirectDelivery = (
      contentKind: "completed_result" | "failed_notice" = textCompletionDirectDeliveryKind,
      agentResult?: { payloads?: unknown },
    ) =>
      deliverCompletionDirect({
        cfg,
        requesterSessionKey: canonicalRequesterSessionKey,
        requesterAgentId: params.requesterAgentId,
        directIdempotencyKey: params.directIdempotencyKey,
        deliveryTarget,
        internalEvents: params.internalEvents,
        contentKind,
        agentResult,
        signal: params.signal,
        onDeliveryResult: params.onDeliveryResult,
        isSourceSessionEffectsAllowed: isCompletionDeliveryAllowed,
      });
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
        directOrigin?.channel,
      sessionEntry: requesterEntry,
    });
    if (
      !recoveredResult &&
      !parentOnly &&
      params.expectsCompletionMessage &&
      requesterActivity.sessionId &&
      requesterActivity.isActive
    ) {
      const wakeOptions: EmbeddedAgentQueueMessageOptions = {
        deliveryTimeoutMs: announceTimeoutMs,
        steeringMode: "all",
        ...(completionSourceReplyDeliveryMode
          ? { sourceReplyDeliveryMode: completionSourceReplyDeliveryMode }
          : {}),
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
        ...(params.createUserTurnTranscriptRecorder
          ? {
              userTurnTranscriptRecorder: params.createUserTurnTranscriptRecorder(
                requesterActivity.sessionId,
              ),
            }
          : {}),
      };
      // Ordinary subagent and harness handoffs must wait through compaction
      // and transcript retries before treating an active wake as failed.
      const wakeOutcome = await resolveActiveWakeWithRetries(
        requesterActivity.sessionId,
        turnMessage,
        wakeOptions,
        params.signal,
        isCompletionDeliveryAllowed,
        params.isSourceSessionAdmissionAllowed,
      );
      if (wakeOutcome === SOURCE_OWNER_CHANGED) {
        return sourceOwnerChangedResult();
      }
      if (wakeOutcome.queued) {
        return {
          delivered: true,
          deliveredAt: wakeOutcome.deliveredAtMs,
          enqueuedAt: wakeOutcome.enqueuedAtMs,
          path: "steered",
        };
      }
      const wakeFailure = formatEmbeddedAgentQueueFailureSummary(wakeOutcome);
      defaultRuntime.log(
        `[warn] Active requester session could not be woken for subagent completion; falling back to requester-agent handoff: active requester session could not be woken${wakeFailure ? `: ${wakeFailure}` : ""}`,
      );
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
      cfg,
      requesterSessionKey: canonicalRequesterSessionKey,
      requesterAgentId: params.requesterAgentId,
      signal: params.signal,
      timeoutMs: announceTimeoutMs,
      parentOnly,
      requesterSessionBound,
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
    let directAnnounceResponse: unknown;
    let directFailure: SubagentAnnounceDeliveryResult | undefined;
    try {
      directAnnounceResponse = recoveredResult
        ? { status: "ok", result: recoveredResult }
        : await runAnnounceDeliveryWithRetry({
            operation: params.expectsCompletionMessage
              ? "completion direct announce agent call"
              : "direct announce agent call",
            signal: params.signal,
            isAttemptAllowed: isCompletionAdmissionAllowed,
            run: async () => {
              if (!isCompletionAdmissionAllowed()) {
                throw new SourceOwnerChangedError();
              }
              return await runAnnounceAgentCall({
                agentParams: directAgentParams,
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
                onExecutionStarted: params.onExecutionStarted,
                // Individual private delivery uses the lifecycle window for admission;
                // settle batches can observe and replay admission.
                timeoutMs: parentOnly && isSubagentCompletion ? undefined : announceTimeoutMs,
                isExecutionAllowed: isCompletionDeliveryAllowed,
                isSourceSessionAdmissionAllowed:
                  params.isSourceSessionAdmissionAllowed && isCompletionAdmissionAllowed,
                resolveGatewayContext: params.resolveGatewayContext,
              });
            },
          });
      if (!isCompletionDeliveryAllowed()) {
        return sourceOwnerChangedResult();
      }
    } catch (err) {
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
      directFailure = {
        delivered: false,
        path: "direct",
        error: summarizeDeliveryError(err),
        disposition: isPermanentAnnounceDeliveryError(err) ? "permanent_failure" : "retryable",
      };
    }

    const classified = directFailure ?? classifyResponse(directAnnounceResponse);
    const delivery = classified instanceof Promise ? await classified : classified;
    if (!isCompletionDeliveryAllowed()) {
      return sourceOwnerChangedResult();
    }
    const originalOutcome = buildAgentRunTerminalOutcomeFromWaitResult(
      asOptionalRecord(directAnnounceResponse),
    );
    if (
      parentOnly ||
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
    const settledRecovery = resolveRequesterRecoveryDelivery(
      currentEntry,
      params.directIdempotencyKey,
    );
    if (!settledRecovery) {
      return delivery;
    }
    // Settle responses cannot take the subagent text-send fallback. Reusing
    // their normal receipt classifier never dispatches or sends the input again.
    if (settledRecovery.kind === "delivery") {
      return settledRecovery.delivery;
    }
    const recoveredDelivery = await classifyResponse({
      status: "ok",
      result: settledRecovery.result,
    });
    if (!isCompletionDeliveryAllowed()) {
      return sourceOwnerChangedResult();
    }
    return recoveredDelivery;
  } catch (err) {
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
