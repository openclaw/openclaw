import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
/**
 * Requester-agent handoff and direct delivery for subagent announcements.
 */
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { completionRequiresMessageToolDelivery } from "../../../auto-reply/reply/completion-delivery-policy.js";
import { stringifyRouteThreadId } from "../../../plugin-sdk/channel-route.js";
import { defaultRuntime } from "../../../runtime.js";
import {
  INTERNAL_PROVENANCE_SOURCE_CHANNEL,
  isAgentMediatedCompletionSourceTool,
} from "../../../sessions/input-provenance.js";
import { isCronRunSessionKey } from "../../../sessions/session-key-utils.js";
import type { UserTurnTranscriptRecorder } from "../../../sessions/user-turn-transcript.types.js";
import { sessionDeliveryChannel } from "../../../utils/delivery-context.shared.js";
import {
  INTERNAL_MESSAGE_CHANNEL,
  isGatewayMessageChannel,
  normalizeMessageChannel,
} from "../../../utils/message-channel.js";
import { normalizeAgentRunTerminalDeliverySnapshot } from "../../agent-run-terminal-delivery.js";
import { buildAgentRunTerminalOutcomeFromWaitResult } from "../../agent-run-terminal-outcome.js";
import {
  getAgentCommandDeliveryFailure,
  getGatewayAgentResult,
  hasCommittedOutboundDeliveryEvidence,
  getAutomaticDeliveryEvidence,
} from "../../embedded-agent-runner/delivery-evidence.js";
import {
  hasIntentionalSilentAgentPayload,
  hasVisibleAgentPayload,
} from "../../embedded-agent-runner/message-visibility.js";
import type { EmbeddedAgentQueueMessageOptions } from "../../embedded-agent-runner/run-state.js";
import {
  AGENT_INTERNAL_EVENT_TYPE_TASK_COMPLETION,
  hasFailedSubagentNoOutputCompletion,
  hasVisibleCompletionResult,
} from "../../internal-event-contract.js";
import type { AgentInternalEvent } from "../../internal-events.js";
import {
  formatActiveWakeFailure,
  isSourceOwnerChangedWake,
  resolveActiveWakeWithRetries,
  resolveRequesterSessionActivity,
} from "./subagent-announce-active-wake.js";
import {
  deliverCompletionDirect,
  hasMessagingToolDeliveryToSource,
  isDirectMessageDeliveryTarget,
  isGatewayAgentRunPending,
  runAnnounceAgentCall,
} from "./subagent-announce-completion-delivery.js";
import {
  hasAnnounceSendEvidence,
  isIncompleteAnnounceAgentResultError,
  isPermanentAnnounceDeliveryError,
  resolveSubagentAnnounceTimeoutMs,
  runAnnounceDeliveryWithRetry,
  SourceOwnerChangedError,
  sourceOwnerChangedResult,
  summarizeDeliveryError,
} from "./subagent-announce-delivery-retry.js";
import {
  getSubagentAnnounceRuntimeConfig,
  resolveSubagentRequesterSessionAbandonment,
  loadRequesterSessionEntry,
  resolveExternalBestEffortDeliveryTarget,
  resolveQueueSettings,
} from "./subagent-announce-delivery.runtime.js";
import type { SubagentAnnounceDeliveryResult } from "./subagent-announce-dispatch.js";
import {
  resolveCompletionDeliveryOrigins,
  type DeliveryContext,
} from "./subagent-announce-origin.js";
import { resolveRequesterStoreKey } from "./subagent-requester-store-key.js";

const REQUESTER_FINAL_VISIBLE_TEXT_MAX_CHARS = 12_000;

export async function sendSubagentAnnounceDirectly(params: {
  requesterSessionKey: string;
  requesterAgentId?: string;
  requesterRunTimeoutSeconds?: number;
  targetRequesterSessionKey: string;
  triggerMessage: string;
  internalEvents?: AgentInternalEvent[];
  expectsCompletionMessage: boolean;
  completionTarget?: "parent";
  completionRequesterSessionId?: string;
  requireVisibleReply?: boolean;
  bestEffortDeliver?: boolean;
  directIdempotencyKey: string;
  completionDirectOrigin?: DeliveryContext;
  directOrigin?: DeliveryContext;
  requesterSessionOrigin?: DeliveryContext;
  sourceSessionKey?: string;
  sourceTool?: string;
  isSourceSessionEffectsAllowed?: () => boolean;
  isCompletionOwnedByRequesterYield?: () => boolean;
  requesterIsSubagent: boolean;
  createUserTurnTranscriptRecorder?: (sessionId: string) => UserTurnTranscriptRecorder;
  onDeliveryResult?: (delivery: SubagentAnnounceDeliveryResult) => void;
  signal?: AbortSignal;
  resolveGatewayContext?: import("../../../gateway/server-methods/types.js").GatewayContextResolver;
}): Promise<SubagentAnnounceDeliveryResult> {
  if (params.signal?.aborted) {
    return { delivered: false, path: "none" };
  }
  const parentOnly = params.completionTarget === "parent";
  const cfg = getSubagentAnnounceRuntimeConfig();
  const announceTimeoutMs = resolveSubagentAnnounceTimeoutMs(cfg);
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
    const requesterEntry = loadRequesterSessionEntry(
      params.targetRequesterSessionKey,
      params.requesterAgentId,
    ).entry;
    const deliveryTarget =
      !parentOnly && !params.requesterIsSubagent
        ? resolveExternalBestEffortDeliveryTarget({
            channel: effectiveDirectOrigin?.channel,
            to: effectiveDirectOrigin?.to,
            accountId: effectiveDirectOrigin?.accountId,
            threadId: effectiveDirectOrigin?.threadId,
          })
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
    const subagentCompletionEvents = params.internalEvents?.filter(
      (event) =>
        event.type === AGENT_INTERNAL_EVENT_TYPE_TASK_COMPLETION && event.source === "subagent",
    );
    const trustedCompletionEvent =
      subagentCompletionEvents?.length === 1 &&
      subagentCompletionEvents[0]?.childSessionKey === params.sourceSessionKey
        ? subagentCompletionEvents[0]
        : undefined;
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
      params.requesterAgentId,
    );
    if (
      parentOnly &&
      (!params.completionRequesterSessionId ||
        requesterActivity.sessionId !== params.completionRequesterSessionId)
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
      ? resolveSubagentRequesterSessionAbandonment(
          canonicalRequesterSessionKey,
          requesterActivity.sessionId,
        )
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
    if (!isCompletionDeliveryAllowed()) {
      // sessions_yield owns the post-turn synthesis. Starting or steering a
      // requester turn here would replay the original fanout during handoff.
      return {
        delivered: false,
        path: "none",
        reason: "completion_handoff_pending",
        terminal: true,
        disposition: "intentional_non_delivery",
      };
    }
    const tryTextCompletionDirectDelivery = (
      contentKind: "completed_result" | "failed_notice" = "completed_result",
    ) =>
      deliverCompletionDirect({
        cfg,
        requesterSessionKey: canonicalRequesterSessionKey,
        requesterAgentId: params.requesterAgentId,
        directIdempotencyKey: params.directIdempotencyKey,
        deliveryTarget,
        internalEvents: params.internalEvents,
        contentKind,
        signal: params.signal,
        onDeliveryResult: params.onDeliveryResult,
        isSourceSessionEffectsAllowed: isCompletionDeliveryAllowed,
      });
    // Synthetic requester-settle turns must not inherit a tool-only mode that suppresses the final.
    const completionSourceReplyDeliveryMode = parentOnly
      ? "automatic"
      : requiresMessageToolDelivery
        ? "message_tool_only"
        : params.requireVisibleReply && deliveryTarget.deliver
          ? "automatic"
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
        params.triggerMessage,
        wakeOptions,
        params.signal,
        isCompletionDeliveryAllowed,
      );
      if (isSourceOwnerChangedWake(wakeOutcome)) {
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
      defaultRuntime.log(
        `[warn] Active requester session could not be woken for subagent completion; falling back to requester-agent handoff: ${formatActiveWakeFailure(
          "active requester session could not be woken",
          wakeOutcome,
        )}`,
      );
    }
    if (
      params.expectsCompletionMessage &&
      isCronRunSessionKey(canonicalRequesterSessionKey) &&
      !resolveRequesterSessionActivity(params.targetRequesterSessionKey, params.requesterAgentId)
        .isActive &&
      !agentMediatedCompletion
    ) {
      return {
        delivered: false,
        path: "none",
        reason: "completion_handoff_pending",
        terminal: true,
        disposition: "intentional_non_delivery",
      };
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
    const directAgentParams: Record<string, unknown> = {
      ...(parentOnly ? { expectedExistingSessionId: params.completionRequesterSessionId } : {}),
      sessionKey: canonicalRequesterSessionKey,
      timeout: params.requesterRunTimeoutSeconds,
      message: params.triggerMessage,
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
    let directAnnounceResponse: unknown;
    try {
      directAnnounceResponse = await runAnnounceDeliveryWithRetry({
        operation: params.expectsCompletionMessage
          ? "completion direct announce agent call"
          : "direct announce agent call",
        signal: params.signal,
        isAttemptAllowed: isCompletionDeliveryAllowed,
        run: async () => {
          if (!isCompletionDeliveryAllowed()) {
            throw new SourceOwnerChangedError();
          }
          return await runAnnounceAgentCall({
            agentParams: directAgentParams,
            ...(parentOnly ? { privateCompletion: true as const } : {}),
            delegatedToolPolicyHandoff:
              isSubagentCompletion &&
              trustedCompletionEvent &&
              params.sourceSessionKey &&
              requesterActivity.sessionId &&
              params.isSourceSessionEffectsAllowed?.() !== false
                ? {
                    sourceSessionKey: params.sourceSessionKey,
                    ...(trustedCompletionEvent.childSessionId
                      ? { sourceSessionId: trustedCompletionEvent.childSessionId }
                      : {}),
                    targetSessionKey: canonicalRequesterSessionKey,
                    targetSessionId: requesterActivity.sessionId,
                    idempotencyKey: params.directIdempotencyKey,
                  }
                : undefined,
            expectFinal: true,
            signal: params.signal,
            // Individual private delivery retains its cleanup owner until the
            // lifecycle deadline; settle batches can observe and replay admission.
            timeoutMs: parentOnly && isSubagentCompletion ? undefined : announceTimeoutMs,
            isExecutionAllowed: isCompletionDeliveryAllowed,
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
      // The requester-agent handoff is the delivery contract for background
      // completions. A failed handoff should retry/fail visibly instead
      // of sending the child result directly to the external channel.
      throw err;
    }

    if (isGatewayAgentRunPending(directAnnounceResponse)) {
      return parentOnly
        ? {
            delivered: false,
            path: "direct",
            reason: "requester_turn_pending",
            disposition: "retryable",
          }
        : { delivered: true, path: "direct" };
    }

    const directAnnounceResult = getGatewayAgentResult(directAnnounceResponse);
    const directAnnounceRecord = asOptionalRecord(directAnnounceResponse);
    if (parentOnly) {
      const outcome = buildAgentRunTerminalOutcomeFromWaitResult(directAnnounceRecord);
      if (outcome?.reason === "cancelled" && outcome.stopReason !== "restart") {
        return {
          delivered: false,
          path: "direct",
          terminal: true,
          reason: "delivery_suppressed",
          disposition: "intentional_non_delivery",
          error: "private requester continuation was cancelled",
        };
      }
      // Successful internal consumption may be silent or start the next child.
      // Queue acceptance alone is not consumption, and no external receipt is owed.
      return directAnnounceRecord?.status === "ok" &&
        directAnnounceRecord?.inputProcessingCompleted === true
        ? { delivered: true, path: "direct" }
        : {
            delivered: false,
            path: "direct",
            reason: "completion_handoff_pending",
            error: "private requester turn has not completed successfully",
            disposition: "retryable",
          };
    }
    const hasFinalMessagingToolDelivery = Boolean(
      directAnnounceResult &&
      hasMessagingToolDeliveryToSource(directAnnounceResult, deliveryTarget, {
        requireFinalReply: true,
      }),
    );
    const hasMessagingToolDelivery = Boolean(
      directAnnounceResult &&
      hasMessagingToolDeliveryToSource(directAnnounceResult, deliveryTarget),
    );
    const requiresAutomaticFinalReceipt =
      shouldDeliverAgentFinal && (params.expectsCompletionMessage || params.requireVisibleReply);
    const automaticEvidence = getAutomaticDeliveryEvidence(directAnnounceResult ?? {});
    const directDeliveryFailure =
      (shouldDeliverAgentFinal || requiresMessageToolDelivery) && directAnnounceResult
        ? getAgentCommandDeliveryFailure(directAnnounceResult)
        : undefined;
    // Automatic-delivery diagnostics and a committed source message are independent facts.
    // Once the message tool delivered the owed final, the task must settle as delivered.
    if (
      directDeliveryFailure &&
      !(requiresAutomaticFinalReceipt ? hasFinalMessagingToolDelivery : hasMessagingToolDelivery)
    ) {
      return {
        delivered: false,
        path: "direct",
        error: directDeliveryFailure,
        ...(automaticEvidence.mayHaveSent ? { disposition: "ambiguous" as const } : {}),
      };
    }
    const hasVisibleNonSilentGatewayPayload = Boolean(
      directAnnounceResult &&
      hasVisibleAgentPayload(directAnnounceResult, {
        includeErrorPayloads: false,
        includeReasoningPayloads: false,
        requireTerminalContent: true,
        includeSilentReplyPayloads: false,
      }),
    );
    const terminalDelivery = normalizeAgentRunTerminalDeliverySnapshot(
      directAnnounceResult?.deliveryStatus,
    );
    const automaticFinalDelivered =
      terminalDelivery?.status === "sent" && terminalDelivery.resultCount > 0;
    if (
      requiresAutomaticFinalReceipt &&
      !hasFinalMessagingToolDelivery &&
      terminalDelivery?.status === "suppressed" &&
      // Only genuinely empty output can fall back; another payload may have
      // been sent or intentionally cancelled by policy.
      (automaticEvidence.mayHaveSent ||
        automaticEvidence.suppressionReason !== "no_visible_payload")
    ) {
      return {
        delivered: false,
        path: "direct",
        reason: automaticEvidence.mayHaveSent ? undefined : "delivery_suppressed",
        error: automaticEvidence.mayHaveSent
          ? "automatic completion delivery could not be confirmed"
          : (automaticEvidence.suppressionReason ?? "automatic completion delivery suppressed"),
        disposition: automaticEvidence.mayHaveSent ? "ambiguous" : "intentional_non_delivery",
        terminal: automaticEvidence.mayHaveSent ? undefined : true,
      };
    }
    if (
      directAnnounceRecord?.status === "ok" &&
      directAnnounceResult?.meta?.yielded === true &&
      !directAnnounceResult.meta.error &&
      !directAnnounceResult.meta.aborted &&
      !automaticFinalDelivered
    ) {
      if (
        directAnnounceResult.requesterContinuationSettled === true &&
        !hasFinalMessagingToolDelivery &&
        !hasVisibleNonSilentGatewayPayload
      ) {
        // Core owns the next wave or observed it complete. Real final evidence
        // still follows its normal path below.
        return { delivered: true, path: "direct" };
      }
      if (
        isSubagentCompletion &&
        params.expectsCompletionMessage &&
        requiresMessageToolDelivery &&
        !hasMessagingToolDelivery
      ) {
        // A yielded requester still owns pending work, not a tool-running fallback.
        return {
          delivered: false,
          path: "direct",
          reason: "completion_handoff_pending",
          disposition: "session_queued",
        };
      }
    }
    const hasIntentionalSilentCompletionReply = Boolean(
      directAnnounceResult && hasIntentionalSilentAgentPayload(directAnnounceResult),
    );
    const hasCompletionSideEffect = Boolean(
      directAnnounceResult && hasCommittedOutboundDeliveryEvidence(directAnnounceResult),
    );
    const hasVisibleRequiredCompletionReply =
      hasMessagingToolDelivery ||
      (!requiresMessageToolDelivery && hasVisibleNonSilentGatewayPayload);
    if (
      params.expectsCompletionMessage &&
      shouldDeliverAgentFinal &&
      isSubagentCompletion &&
      !hasVisibleNonSilentGatewayPayload &&
      !hasMessagingToolDelivery
    ) {
      const textDelivery = await tryTextCompletionDirectDelivery(textCompletionDirectDeliveryKind);
      if (textDelivery) {
        return textDelivery;
      }
      if (hasSuccessfulTrustedSubagentNoOutputCompletion && !hasCompletionSideEffect) {
        return {
          delivered: false,
          path: "direct",
          reason: "visible_reply_missing",
          error: "completion agent did not produce a visible reply",
        };
      }
    }
    if (
      hasSuccessfulTrustedSubagentNoOutputCompletion &&
      !hasVisibleRequiredCompletionReply &&
      hasCompletionSideEffect
    ) {
      return {
        delivered: false,
        path: "direct",
        reason: "visible_reply_missing",
        error: "completion agent did not produce a visible reply",
        disposition: "permanent_failure",
      };
    }
    if (
      params.expectsCompletionMessage &&
      requiresMessageToolDelivery &&
      !hasMessagingToolDelivery &&
      (!hasIntentionalSilentCompletionReply ||
        subagentDirectMessageCompletionRequiresMessageTool ||
        hasRequiredSubagentNoOutputCompletion)
    ) {
      if (hasSuccessfulTrustedSubagentNoOutputCompletion) {
        return {
          delivered: false,
          path: "direct",
          reason: "visible_reply_missing",
          error: "completion agent did not produce a visible reply",
        };
      }
      if (subagentDirectMessageCompletionRequiresMessageTool) {
        const textDelivery = await tryTextCompletionDirectDelivery(
          textCompletionDirectDeliveryKind,
        );
        if (textDelivery) {
          return textDelivery;
        }
      }
      return {
        delivered: false,
        path: "direct",
        reason: "message_tool_delivery_missing",
        error: "completion agent did not use the message tool for message-tool-only delivery",
        // The requester execution finished; another agent turn can repeat its
        // effects. Retain the completion for explicit recovery instead.
        disposition: "permanent_failure",
      };
    }
    const hasRequesterVisibleFinalDelivery =
      hasFinalMessagingToolDelivery || (shouldDeliverAgentFinal && automaticFinalDelivered);
    const hasVisibleCompletionReply =
      hasRequesterVisibleFinalDelivery ||
      (!shouldDeliverAgentFinal && !params.requireVisibleReply && hasMessagingToolDelivery) ||
      // Nested requesters and internal sessions observe the final in their transcript.
      // Unresolved external origins still require delivery evidence.
      (!requiresMessageToolDelivery &&
        hasVisibleNonSilentGatewayPayload &&
        directAnnounceResult?.deliveryStatus?.status !== "suppressed" &&
        (params.requesterIsSubagent ||
          [effectiveDirectOrigin, requesterSessionOrigin].every((origin) =>
            origin?.channel
              ? normalizeMessageChannel(origin.channel) === INTERNAL_MESSAGE_CHANNEL
              : !origin?.to,
          )));
    const acceptsIntentionalSilentCompletion =
      hasIntentionalSilentCompletionReply && !isSubagentCompletion;
    if (
      !hasVisibleCompletionReply &&
      (params.requireVisibleReply ||
        (params.expectsCompletionMessage &&
          (shouldDeliverAgentFinal ||
            (!requiresMessageToolDelivery &&
              !hasCompletionSideEffect &&
              !acceptsIntentionalSilentCompletion))))
    ) {
      return {
        delivered: false,
        path: "direct",
        reason: "visible_reply_missing",
        error: "completion agent did not produce a visible reply",
      };
    }
    const requesterVisibleFinalCommitted =
      !params.requesterIsSubagent &&
      (hasRequesterVisibleFinalDelivery ||
        (!params.expectsCompletionMessage &&
          directAnnounceRecord?.status === "ok" &&
          hasVisibleNonSilentGatewayPayload &&
          hasVisibleCompletionReply));
    const finalAssistantVisibleText =
      requesterVisibleFinalCommitted &&
      typeof directAnnounceResult?.meta?.finalAssistantVisibleText === "string"
        ? truncateUtf16Safe(
            directAnnounceResult.meta.finalAssistantVisibleText.trim(),
            REQUESTER_FINAL_VISIBLE_TEXT_MAX_CHARS,
          )
        : "";

    return {
      delivered: true,
      path: "direct",
      // Synthetic wakes can commit their final to the requester transcript.
      // A canceled partial payload or accepted handoff is not that receipt.
      ...(requesterVisibleFinalCommitted ? { requesterVisibleFinalDelivered: true } : {}),
      ...(finalAssistantVisibleText ? { finalAssistantVisibleText } : {}),
    };
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
