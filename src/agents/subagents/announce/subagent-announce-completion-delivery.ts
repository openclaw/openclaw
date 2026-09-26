/**
 * Requester completion calls, direct fallback, and source-delivery evidence.
 */
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { sanitizePendingFinalDeliveryText } from "../../../auto-reply/reply/pending-final-delivery-state.js";
import type { ChannelId } from "../../../channels/plugins/channel-id.types.js";
import { getLoadedChannelPluginEntryById } from "../../../channels/plugins/registry-loaded.js";
import {
  getRestartRecoveryTerminalDeliveryEvidence,
  hasRestartRecoverySourceClaim,
  hasRestartRecoveryTerminalRun,
} from "../../../config/sessions/restart-recovery-state.js";
import type { RestartRecoveryTerminalDeliveryEvidence } from "../../../config/sessions/restart-recovery-types.js";
import type { SessionEntry } from "../../../config/sessions/types.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { waitForGatewayDispatch } from "../../../gateway/server-in-process-dispatch.js";
import {
  matchSourceDeliveryTargetWithPlugin,
  type SourceDeliveryMessageToolTarget,
  type SourceDeliveryTarget,
} from "../../../infra/outbound/source-delivery-target-match.js";
import { resolveAgentRoute } from "../../../routing/resolve-route.js";
import { normalizeAgentId } from "../../../routing/session-key.js";
import { shouldPreserveUserFacingSessionStateForInputProvenance } from "../../../sessions/input-provenance.js";
import { deriveSessionChatTypeFromKey } from "../../../sessions/session-chat-type-shared.js";
import { isNonTerminalAgentRunStatus } from "../../../shared/agent-run-status.js";
import type { DeliveryContext } from "../../../utils/delivery-context.types.js";
import { normalizeMessageChannel } from "../../../utils/message-channel.js";
import { buildAgentRunTerminalOutcomeFromWaitResult } from "../../agent-run-terminal-outcome.js";
import { sanitizeAgentRunTerminalReplyText } from "../../agent-run-terminal-reply.js";
import {
  getGatewayAgentResult,
  hasCommittedSourceReplyDeliveryEvidence,
  hasMessagingToolDeliveryEvidence,
  hasUnaccountedMessagingToolAggregateEvidence,
  resolveExplicitFinalSourceReplyDeliveryEvidence,
} from "../../embedded-agent-runner/delivery-evidence.js";
import { hasVisibleCompletionResult } from "../../internal-event-contract.js";
import type { AgentInternalEvent } from "../../internal-events.js";
import { createAgentRunDirectAbortError } from "../../run-termination.js";
import {
  SourceOwnerChangedError,
  summarizeDeliveryError,
} from "./subagent-announce-delivery-retry.js";
import {
  dispatchSubagentAnnounceAgent,
  sendSubagentAnnounceMessage,
  tryResolveSubagentRequesterAgentId,
} from "./subagent-announce-delivery.runtime.js";
import {
  sourceOwnerChangedResult,
  type SubagentAnnounceDeliveryResult,
} from "./subagent-announce-dispatch.js";
import type { SubagentCompletionToolHandoffRegistration } from "./subagent-announce-handoff.js";
import { inferDeliveryTargetChatType } from "./subagent-announce-origin.js";

export type { SourceDeliveryTarget } from "../../../infra/outbound/source-delivery-target-match.js";

export async function runAnnounceAgentCall(params: {
  agentParams: Record<string, unknown>;
  privateCompletion?: true;
  settleWakeSourceSessionKeys?: readonly string[];
  delegatedToolPolicyHandoff?: SubagentCompletionToolHandoffRegistration;
  expectFinal?: boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
  isExecutionAllowed: () => boolean;
  isSourceSessionAdmissionAllowed?: () => boolean;
  resolveGatewayContext?: import("../../../gateway/server-methods/types.js").GatewayContextResolver;
}): Promise<unknown> {
  const deadline = new AbortController();
  const sourceLifecycle = new AbortController();
  const isSourceSessionAdmissionAllowed = params.isSourceSessionAdmissionAllowed;
  const lifecycleSignal = params.signal
    ? AbortSignal.any([params.signal, sourceLifecycle.signal])
    : sourceLifecycle.signal;
  const signal = AbortSignal.any([lifecycleSignal, deadline.signal]);
  // A private input stays owned by Gateway admission when an observer times out.
  // Caller or source lifecycle cancellation still stops that underlying turn.
  const executionSignal = params.privateCompletion ? lifecycleSignal : signal;
  const timer =
    params.timeoutMs === undefined
      ? undefined
      : setTimeout(
          () => deadline.abort(new Error("gateway request timeout for agent")),
          params.timeoutMs,
        );
  timer?.unref?.();
  try {
    signal.throwIfAborted();
    const dispatch = dispatchSubagentAnnounceAgent(params.agentParams, {
      cancelOnDeadline: true,
      privateCompletion: params.privateCompletion,
      settleWakeReplay: params.settleWakeSourceSessionKeys
        ? {
            sourceSessionKeys: params.settleWakeSourceSessionKeys,
            assertCurrent: () => {
              if (!params.isExecutionAllowed()) {
                throw new SourceOwnerChangedError();
              }
            },
          }
        : undefined,
      expectFinal: params.expectFinal,
      forceSyntheticClient: shouldPreserveUserFacingSessionStateForInputProvenance(
        params.agentParams.inputProvenance,
      ),
      operatorRoleActor: { kind: "system" },
      delegatedToolPolicyHandoff: params.delegatedToolPolicyHandoff,
      signal: executionSignal,
      ...(isSourceSessionAdmissionAllowed
        ? {
            sessionMutationCommitGuard: () => {
              if (!isSourceSessionAdmissionAllowed()) {
                const error = new SourceOwnerChangedError();
                sourceLifecycle.abort(error);
                throw error;
              }
            },
          }
        : {}),
      // Accepted queue waits belong to session admission; execution belongs to
      // the requester runtime budget, not the announcement handoff deadline.
      onAccepted: () => clearTimeout(timer),
      onExecutionStarted: () => {
        executionSignal.throwIfAborted();
        if (!params.isExecutionAllowed()) {
          sourceLifecycle.abort(new SourceOwnerChangedError());
          // Classify execution immediately, before Gateway observes cancellation.
          throw createAgentRunDirectAbortError();
        }
        // Execution can be observed before acceptance on an already-running replay.
        clearTimeout(timer);
      },
      resolveGatewayContext: params.resolveGatewayContext,
    });
    return params.privateCompletion
      ? await waitForGatewayDispatch("agent", dispatch, undefined, signal)
      : await dispatch;
  } catch (error) {
    sourceLifecycle.signal.throwIfAborted();
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

const FAILED_COMPLETION_NOTICE =
  "A delegated task failed before it could report a result. Please retry the task.";
const MAX_MESSAGING_TOOL_DELIVERY_VERIFICATION_TIMEOUT_MS = 10_000;

async function resolveEquivalentMessagingToolTarget(
  params: {
    cfg: OpenClawConfig;
    requesterSessionKey: string;
    requesterAgentId?: string;
    signal?: AbortSignal;
  },
  target: MessagingToolDeliveryTarget,
  expected: SourceDeliveryTarget,
): Promise<string | undefined> {
  const agentId = tryResolveSubagentRequesterAgentId(
    params.cfg,
    params.requesterSessionKey,
    params.requesterAgentId,
  );
  const channel = normalizeMessageChannel(expected.channel);
  const provider = target.provider?.trim().toLowerCase();
  if (
    !channel ||
    !agentId ||
    !target.to?.trim() ||
    (provider && provider !== "message" && provider !== channel) ||
    (expected.accountId && target.accountId !== expected.accountId)
  ) {
    return undefined;
  }
  params.signal?.throwIfAborted();
  const accountId = target.accountId ?? expected.accountId ?? null;
  const resolver =
    getLoadedChannelPluginEntryById(channel)?.plugin.messaging?.resolveOutboundSessionRoute;
  if (!resolver) {
    return undefined;
  }
  const route = await resolver({
    cfg: params.cfg,
    agentId,
    accountId,
    target: target.to,
    threadId: target.threadId ?? null,
    signal: params.signal,
  });
  if (!route || route.recipientSessionExact !== true) {
    return undefined;
  }
  const bindingRoute = resolveAgentRoute({
    cfg: params.cfg,
    channel: channel as ChannelId,
    defaultAgentId: agentId,
    accountId,
    peer: route.peer,
  });
  return normalizeAgentId(bindingRoute.agentId) === normalizeAgentId(agentId)
    ? route.to
    : undefined;
}

export function isGatewayAgentRunPending(response: unknown): boolean {
  if (!response || typeof response !== "object") {
    return false;
  }
  const status = (response as { status?: unknown }).status;
  return isNonTerminalAgentRunStatus(status);
}

/** A recovery successor owns its admitted input until its exact final can be reconciled. */
export function resolveRequesterRecoveryDelivery(
  entry: SessionEntry | undefined,
  runId: string,
):
  | { kind: "result"; result: RestartRecoveryTerminalDeliveryEvidence }
  | { kind: "delivery"; delivery: SubagentAnnounceDeliveryResult }
  | undefined {
  const result = getRestartRecoveryTerminalDeliveryEvidence(entry, runId);
  if (result) {
    return { kind: "result", result };
  }
  if (hasRestartRecoverySourceClaim(entry, runId)) {
    return {
      kind: "delivery",
      delivery: {
        delivered: false,
        path: "direct",
        reason: "requester_turn_pending",
        disposition: "retryable",
      },
    };
  }
  if (hasRestartRecoveryTerminalRun(entry, runId)) {
    return {
      kind: "delivery",
      delivery: {
        delivered: false,
        path: "direct",
        reason: "visible_reply_missing",
        error: "recovered requester completed without durable final delivery evidence",
        disposition: "permanent_failure",
      },
    };
  }
  return undefined;
}

export async function resolvePrivateCompletionDeliveryResult(
  response: Record<string, unknown> | undefined,
  origin?: DeliveryContext,
): Promise<SubagentAnnounceDeliveryResult> {
  const outcome = buildAgentRunTerminalOutcomeFromWaitResult(response);
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
  const delivery: SubagentAnnounceDeliveryResult =
    response?.status === "ok" && response?.inputProcessingCompleted === true
      ? { delivered: true, path: "direct" }
      : {
          delivered: false,
          path: "direct",
          reason: "completion_handoff_pending",
          error: "private requester turn has not completed successfully",
          disposition: "retryable",
        };
  const result = getGatewayAgentResult(response);
  if (
    delivery.delivered &&
    origin?.channel &&
    origin.to &&
    result &&
    result.meta?.yielded !== true &&
    result.meta?.continuationPending !== true &&
    (await hasMessagingToolDeliveryToSource(result, origin, { requireFinalReply: true }))
  ) {
    delivery.requesterVisibleFinalDelivered = true;
  }
  return delivery;
}

export function buildRequesterCompletionDeliveryResult(
  finalCommitted: boolean,
  text: unknown,
): SubagentAnnounceDeliveryResult {
  const finalAssistantVisibleText =
    finalCommitted && typeof text === "string" ? truncateUtf16Safe(text.trim(), 12_000) : "";
  return {
    delivered: true,
    path: "direct",
    // A canceled partial payload or accepted handoff is not a visible final receipt.
    ...(finalCommitted ? { requesterVisibleFinalDelivered: true } : {}),
    ...(finalAssistantVisibleText ? { finalAssistantVisibleText } : {}),
  };
}

export function isDirectMessageDeliveryTarget(
  target: { channel?: string; to?: string; threadId?: string },
  requesterSessionKey: string,
): boolean {
  if (target.threadId) {
    return false;
  }
  const targetChatType = inferDeliveryTargetChatType(target);
  if (targetChatType) {
    return targetChatType === "direct";
  }
  return deriveSessionChatTypeFromKey(requesterSessionKey) === "direct";
}

function resolveTextCompletionDirectFallback(
  events: readonly AgentInternalEvent[] | undefined,
  contentKind: "completed_result" | "failed_notice",
) {
  if (contentKind === "failed_notice") {
    return FAILED_COMPLETION_NOTICE;
  }
  for (let index = (events?.length ?? 0) - 1; index >= 0; index -= 1) {
    const event = events?.[index];
    if (event?.type !== "task_completion" || event.source !== "subagent") {
      continue;
    }
    if (event.status !== "ok") {
      continue;
    }
    // Placeholder copy for an absent child result is not deliverable content.
    if (!hasVisibleCompletionResult(event)) {
      continue;
    }
    const result =
      typeof event.result === "string"
        ? sanitizeAgentRunTerminalReplyText(sanitizePendingFinalDeliveryText(event.result))
        : "";
    if (result) {
      return result;
    }
  }
  return undefined;
}

export async function deliverCompletionDirect(params: {
  cfg: OpenClawConfig;
  requesterSessionKey: string;
  requesterAgentId?: string;
  directIdempotencyKey: string;
  deliveryTarget: {
    deliver: boolean;
    channel?: string;
    to?: string;
    accountId?: string;
    threadId?: string;
  };
  internalEvents?: readonly AgentInternalEvent[];
  contentKind: "completed_result" | "failed_notice";
  signal?: AbortSignal;
  onDeliveryResult?: (delivery: SubagentAnnounceDeliveryResult) => void | Promise<void>;
  isSourceSessionEffectsAllowed?: () => boolean;
}): Promise<SubagentAnnounceDeliveryResult | undefined> {
  const content = resolveTextCompletionDirectFallback(params.internalEvents, params.contentKind);
  if (
    !content ||
    !params.deliveryTarget.deliver ||
    !params.deliveryTarget.channel ||
    !params.deliveryTarget.to ||
    !isDirectMessageDeliveryTarget(params.deliveryTarget, params.requesterSessionKey)
  ) {
    return undefined;
  }
  const agentId = tryResolveSubagentRequesterAgentId(
    params.cfg,
    params.requesterSessionKey,
    params.requesterAgentId,
  );
  if (!agentId) {
    return undefined;
  }
  const idempotencyKey = `${params.directIdempotencyKey}:text-direct`;
  let committedDelivery: SubagentAnnounceDeliveryResult | undefined;
  try {
    if (params.isSourceSessionEffectsAllowed?.() === false) {
      return sourceOwnerChangedResult();
    }
    if (params.signal?.aborted) {
      return { delivered: false, path: "none" };
    }
    const sendResult = await sendSubagentAnnounceMessage({
      cfg: params.cfg,
      channel: params.deliveryTarget.channel,
      to: params.deliveryTarget.to,
      accountId: params.deliveryTarget.accountId,
      threadId: params.deliveryTarget.threadId,
      requesterSessionKey: params.requesterSessionKey,
      agentId,
      conversationType: "direct",
      content,
      idempotencyKey,
      skipQueue: true,
      abortSignal: params.signal,
      onPlatformSendDispatch: async () => {
        params.signal?.throwIfAborted();
        if (params.isSourceSessionEffectsAllowed?.() === false) {
          throw new SourceOwnerChangedError();
        }
      },
      onDeliveryResult: async () => {
        if (committedDelivery) {
          return;
        }
        // Platform identity is committed before transcript mirroring, which
        // may wait behind the requester's still-active SQLite writer.
        committedDelivery = { delivered: true, path: "direct", deliveredAt: Date.now() };
        await params.onDeliveryResult?.(committedDelivery);
      },
      mirror: {
        sessionKey: params.requesterSessionKey,
        agentId,
        idempotencyKey,
      },
    });
    if (committedDelivery) {
      return committedDelivery;
    }
    if (sendResult.deliveryStatus === "suppressed") {
      const ambiguous = sendResult.suppressionReason === "adapter_returned_no_identity";
      return {
        delivered: false,
        path: "direct",
        reason: ambiguous ? undefined : "delivery_suppressed",
        error: ambiguous
          ? "text completion direct delivery could not be confirmed: adapter returned no identity"
          : `text completion direct delivery was suppressed: ${sendResult.suppressionReason ?? "unknown reason"}`,
        ...(ambiguous
          ? { disposition: "ambiguous" as const }
          : { disposition: "intentional_non_delivery" as const, terminal: true }),
      };
    }
    return { delivered: true, path: "direct" };
  } catch (err) {
    if (committedDelivery) {
      // Post-send bookkeeping must never turn an identified delivery into a
      // retryable failure and send the same completion twice.
      return committedDelivery;
    }
    if (err instanceof SourceOwnerChangedError) {
      return sourceOwnerChangedResult();
    }
    if (params.signal?.aborted) {
      return { delivered: false, path: "none" };
    }
    return {
      delivered: false,
      path: "direct",
      error: `text completion direct delivery failed: ${summarizeDeliveryError(err)}`,
    };
  }
}

type MessagingToolDeliveryTarget = SourceDeliveryMessageToolTarget;

function sourceDeliveryTargetsMatch(
  target: MessagingToolDeliveryTarget,
  delivery: SourceDeliveryTarget,
): boolean {
  const channel = normalizeMessageChannel(delivery.channel);
  return channel
    ? matchSourceDeliveryTargetWithPlugin(
        target,
        delivery,
        getLoadedChannelPluginEntryById(channel)?.plugin,
      )
    : false;
}

type MessagingToolDeliveryMatchOptions = {
  requireFinalReply?: boolean;
  signal?: AbortSignal;
  /** Resolve provider-native delivery identities to the configured source target. */
  resolveEquivalentTarget?: (
    target: MessagingToolDeliveryTarget,
    deliveryTarget: SourceDeliveryTarget,
    signal?: AbortSignal,
  ) => Promise<string | undefined>;
};

export type MessagingToolDeliveryResult = {
  didDeliverSourceReplyViaMessageTool?: unknown;
  didSendViaMessagingTool?: unknown;
  messagingToolSentTargets?: unknown;
  messagingToolSourceReplyPayloads?: unknown;
};

async function hasMessagingToolDeliveryToSource(
  result: MessagingToolDeliveryResult,
  deliveryTarget: SourceDeliveryTarget,
  options?: MessagingToolDeliveryMatchOptions,
): Promise<boolean> {
  const targets = Array.isArray(result.messagingToolSentTargets)
    ? result.messagingToolSentTargets
    : [];
  const sourceTargets: MessagingToolDeliveryTarget[] = [];
  const equivalentTargetCandidates: MessagingToolDeliveryTarget[] = [];
  for (const target of targets) {
    if (
      !target ||
      typeof target !== "object" ||
      Array.isArray(target) ||
      !deliveryTarget.channel ||
      !deliveryTarget.to
    ) {
      continue;
    }
    // SAFETY: the preceding guards establish the object shape required by this receipt record.
    const record = target as MessagingToolDeliveryTarget;
    // Older source receipts omit `to`; explicit off-target sends must never satisfy it.
    const sourceTarget =
      typeof record.to === "string" && record.to.trim()
        ? record
        : { ...record, to: deliveryTarget.to };
    if (sourceDeliveryTargetsMatch(sourceTarget, deliveryTarget)) {
      sourceTargets.push(sourceTarget);
      continue;
    }
    if (!options?.resolveEquivalentTarget || !record.to?.trim()) {
      continue;
    }
    // The existing exact-match path preserves legacy receipts, but a provider
    // lookup must never turn a missing account into a wildcard.
    if (deliveryTarget.accountId && record.accountId !== deliveryTarget.accountId) {
      continue;
    }
    equivalentTargetCandidates.push(sourceTarget);
  }

  const hasFinalSourceDelivery = () => {
    const hasCommittedSourceDelivery =
      hasCommittedSourceReplyDeliveryEvidence(result) ||
      (hasMessagingToolDeliveryEvidence(result) && sourceTargets.length > 0);
    // Only current-source final markers count; another target's final cannot
    // turn a source progress update into the owed requester reply.
    return (
      hasCommittedSourceDelivery &&
      resolveExplicitFinalSourceReplyDeliveryEvidence({
        messagingToolSentTargets: sourceTargets,
        messagingToolSourceReplyPayloads: result.messagingToolSourceReplyPayloads,
      }) !== false
    );
  };
  const hasSourceDelivery = () => {
    if (
      hasCommittedSourceReplyDeliveryEvidence(result) ||
      hasUnaccountedMessagingToolAggregateEvidence({ ...result, didSendViaMessagingTool: false })
    ) {
      return true;
    }

    if (targets.length === 0 || !deliveryTarget.channel || !deliveryTarget.to) {
      return hasMessagingToolDeliveryEvidence(result);
    }

    return hasMessagingToolDeliveryEvidence(result) && sourceTargets.length > 0;
  };

  // Exact source receipts are already authoritative. Evaluate them before any
  // provider-native lookup, so a slow or stuck unrelated lookup cannot erase a
  // delivery that was confirmed by the gateway result itself.
  if (options?.requireFinalReply ? hasFinalSourceDelivery() : hasSourceDelivery()) {
    return true;
  }

  const resolveEquivalentTarget = options?.resolveEquivalentTarget;
  if (resolveEquivalentTarget && equivalentTargetCandidates.length > 0) {
    // Provider-native IDs (for example Slack's D… DM channels) can represent
    // the configured source user without being textually equal. Resolve all
    // candidates concurrently: one unrelated lookup may stall, but a source
    // match that completes must still be allowed to settle the announcement.
    const hasResolvedSourceDelivery = await Promise.any(
      equivalentTargetCandidates.map(async (sourceTarget) => {
        try {
          const equivalentTarget = await resolveEquivalentTarget(
            sourceTarget,
            deliveryTarget,
            options.signal,
          );
          if (
            equivalentTarget &&
            sourceDeliveryTargetsMatch({ ...sourceTarget, to: equivalentTarget }, deliveryTarget)
          ) {
            sourceTargets.push({ ...sourceTarget, to: equivalentTarget });
            if (options.requireFinalReply ? hasFinalSourceDelivery() : hasSourceDelivery()) {
              return true;
            }
          }
        } catch {
          // Keep the completion owed when the provider cannot verify the recipient.
        }
        throw new Error("provider-native source delivery was not verified");
      }),
    ).then(
      () => true,
      () => false,
    );
    if (hasResolvedSourceDelivery) {
      return true;
    }
  }

  if (options?.requireFinalReply) {
    return hasFinalSourceDelivery();
  }
  return hasSourceDelivery();
}

export async function resolveMessagingToolDeliveryEvidence(params: {
  cfg: OpenClawConfig;
  requesterSessionKey: string;
  requesterAgentId?: string;
  result: MessagingToolDeliveryResult;
  deliveryTarget: SourceDeliveryTarget;
  signal?: AbortSignal;
  timeoutMs?: number;
  resolveEquivalentTarget?: MessagingToolDeliveryMatchOptions["resolveEquivalentTarget"];
}): Promise<{ hasFinalMessagingToolDelivery: boolean; hasMessagingToolDelivery: boolean }> {
  const verificationTimeoutMs = Math.min(
    Math.max(params.timeoutMs ?? MAX_MESSAGING_TOOL_DELIVERY_VERIFICATION_TIMEOUT_MS, 1),
    MAX_MESSAGING_TOOL_DELIVERY_VERIFICATION_TIMEOUT_MS,
  );
  const verificationDeadline = new AbortController();
  const timer = setTimeout(
    () => verificationDeadline.abort(new Error("messaging tool delivery verification timed out")),
    verificationTimeoutMs,
  );
  timer.unref?.();
  const signal = params.signal
    ? AbortSignal.any([params.signal, verificationDeadline.signal])
    : verificationDeadline.signal;
  const noDelivery: {
    hasFinalMessagingToolDelivery: boolean;
    hasMessagingToolDelivery: boolean;
  } = {
    hasFinalMessagingToolDelivery: false,
    hasMessagingToolDelivery: false,
  };
  let confirmedMessagingToolDelivery = false;
  const verificationAborted = new Promise<typeof noDelivery>((resolve) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      resolve({
        ...noDelivery,
        // A source progress receipt is independently confirmed even when
        // final-reply verification is still waiting on another target.
        hasMessagingToolDelivery: confirmedMessagingToolDelivery,
      });
    };
    if (signal.aborted) {
      onAbort();
    } else {
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
  try {
    const verification = (async () => {
      const equivalentTargetResolver =
        params.resolveEquivalentTarget ??
        ((
          target: MessagingToolDeliveryTarget,
          deliveryTarget: SourceDeliveryTarget,
          callbackSignal?: AbortSignal,
        ) =>
          resolveEquivalentMessagingToolTarget(
            {
              cfg: params.cfg,
              requesterSessionKey: params.requesterSessionKey,
              requesterAgentId: params.requesterAgentId,
              signal: callbackSignal ?? signal,
            },
            target,
            deliveryTarget,
          ));
      const matchOptions = { resolveEquivalentTarget: equivalentTargetResolver, signal };
      // Capture exact, aggregate, or provider-resolved progress before final
      // verification can stall. The resolver is needed here so a native
      // progress target can be credited independently of final verification.
      confirmedMessagingToolDelivery = await hasMessagingToolDeliveryToSource(
        params.result,
        params.deliveryTarget,
        matchOptions,
      );
      const hasFinalMessagingToolDelivery = await hasMessagingToolDeliveryToSource(
        params.result,
        params.deliveryTarget,
        { ...matchOptions, requireFinalReply: true },
      );
      return {
        hasFinalMessagingToolDelivery,
        hasMessagingToolDelivery:
          hasFinalMessagingToolDelivery ||
          confirmedMessagingToolDelivery ||
          (await hasMessagingToolDeliveryToSource(
            params.result,
            params.deliveryTarget,
            matchOptions,
          )),
      };
    })();
    // The provider callback is cooperative, but completion settlement must not
    // inherit that implementation detail. Abort the callback when possible and
    // independently release the completion owner when it ignores the signal.
    return await Promise.race([verification, verificationAborted]);
  } finally {
    clearTimeout(timer);
    // Verification owns this controller so a successful match also cancels
    // any concurrent provider lookups that lost the race.
    verificationDeadline.abort();
  }
}
