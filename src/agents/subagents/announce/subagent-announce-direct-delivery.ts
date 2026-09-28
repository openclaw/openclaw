import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
/**
 * Requester-agent handoff and direct delivery for subagent announcements.
 */
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import { completionRequiresMessageToolDelivery } from "../../../auto-reply/reply/completion-delivery-policy.js";
import { readSessionEntriesFromStoreInWorker } from "../../../config/sessions/session-entry-read-runtime.js";
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
  resolveSubagentRequesterSessionAbandonment,
  loadRequesterSessionEntry,
  resolveExternalBestEffortDeliveryTarget,
  resolveQueueSettings,
} from "./subagent-announce-delivery.runtime.js";
import { createDirectAnnounceResponseClassifier } from "./subagent-announce-direct-response.js";
import {
  sourceOwnerChangedResult,
  type SubagentAnnounceDeliveryResult,
} from "./subagent-announce-dispatch.js";
import {
  resolveCompletionDeliveryOrigins,
  type DeliveryContext,
} from "./subagent-announce-origin.js";
import { resolveRequesterStoreKey } from "./subagent-requester-store-key.js";

export type SubagentAnnounceDirectParams = {
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
  settleWakeSourceSessionKeys?: readonly string[];
  isSourceSessionEffectsAllowed?: () => boolean;
  /** Additional source guard released by the accepting Gateway or injection owner. */
  isSourceSessionAdmissionAllowed?: () => boolean;
  isCompletionOwnedByRequesterYield?: () => boolean;
  requesterIsSubagent: boolean;
  createUserTurnTranscriptRecorder?: (sessionId: string) => UserTurnTranscriptRecorder;
  onDeliveryResult?: (delivery: SubagentAnnounceDeliveryResult) => void | Promise<void>;
  signal?: AbortSignal;
  resolveGatewayContext?: import("../../../gateway/server-methods/types.js").GatewayContextResolver;
};

export async function sendSubagentAnnounceDirectly(
  params: SubagentAnnounceDirectParams,
): Promise<SubagentAnnounceDeliveryResult> {
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
    const requester = loadRequesterSessionEntry(
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
    const isCompletionAdmissionAllowed = () =>
      isCompletionDeliveryAllowed() && params.isSourceSessionAdmissionAllowed?.() !== false;
    if (!isCompletionAdmissionAllowed()) {
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
    // A recovered requester already owns this admitted input. Reuse its final
    // receipt through the normal delivery checks; never execute the old wake again.
    const recovery =
      !parentOnly && sourceToolId === "subagent_settle"
        ? resolveRequesterRecoveryDelivery(requesterEntry, params.directIdempotencyKey)
        : undefined;
    if (recovery?.kind === "delivery") {
      return recovery.delivery;
    }
    const recoveredResult = recovery?.result;
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
        params.isSourceSessionAdmissionAllowed,
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
    const classifyResponse = createDirectAnnounceResponseClassifier({
      params,
      parentOnly,
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
                settleWakeSourceSessionKeys: params.settleWakeSourceSessionKeys,
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
    const originalOutcome = buildAgentRunTerminalOutcomeFromWaitResult(
      asOptionalRecord(directAnnounceResponse),
    );
    if (
      parentOnly ||
      sourceToolId !== "subagent_settle" ||
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
    return settledRecovery.kind === "delivery"
      ? settledRecovery.delivery
      : classifyResponse({ status: "ok", result: settledRecovery.result });
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
