/**
 * Direct completion fallback and source-delivery evidence for subagent announcements.
 */
import { sanitizePendingFinalDeliveryText } from "../../../auto-reply/reply/pending-final-delivery-state.js";
import type { ChannelId } from "../../../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { resolveOutboundSessionRoute } from "../../../infra/outbound/outbound-session.js";
import { sourceDeliveryTargetsMatch } from "../../../infra/outbound/source-delivery-plan.js";
import { deriveSessionChatTypeFromKey } from "../../../sessions/session-chat-type-shared.js";
import { isNonTerminalAgentRunStatus } from "../../../shared/agent-run-status.js";
import { normalizeMessageChannel } from "../../../utils/message-channel.js";
import { sanitizeAgentRunTerminalReplyText } from "../../agent-run-terminal-reply.js";
import {
  hasCommittedSourceReplyDeliveryEvidence,
  hasMessagingToolDeliveryEvidence,
  hasUnaccountedMessagingToolAggregateEvidence,
  resolveExplicitFinalSourceReplyDeliveryEvidence,
} from "../../embedded-agent-runner/delivery-evidence.js";
import { hasVisibleCompletionResult } from "../../internal-event-contract.js";
import type { AgentInternalEvent } from "../../internal-events.js";
import {
  SourceOwnerChangedError,
  sourceOwnerChangedResult,
  summarizeDeliveryError,
} from "./subagent-announce-delivery-retry.js";
import {
  sendSubagentAnnounceMessage,
  tryResolveSubagentRequesterAgentId,
} from "./subagent-announce-delivery.runtime.js";
import type { SubagentAnnounceDeliveryResult } from "./subagent-announce-dispatch.js";
import { inferDeliveryTargetChatType } from "./subagent-announce-origin.js";

const FAILED_COMPLETION_NOTICE =
  "A delegated task failed before it could report a result. Please retry the task.";
const MAX_MESSAGING_TOOL_DELIVERY_VERIFICATION_TIMEOUT_MS = 10_000;

export async function resolveEquivalentMessagingToolTarget(
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
  const route = await resolveOutboundSessionRoute({
    cfg: params.cfg,
    channel: channel as ChannelId,
    agentId,
    accountId: target.accountId ?? expected.accountId ?? null,
    target: target.to,
    threadId: target.threadId ?? null,
    signal: params.signal,
  });
  return route?.recipientSessionExact === true ? route.to : undefined;
}

export function isGatewayAgentRunPending(response: unknown): boolean {
  if (!response || typeof response !== "object") {
    return false;
  }
  const status = (response as { status?: unknown }).status;
  return isNonTerminalAgentRunStatus(status);
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
  onDeliveryResult?: (delivery: SubagentAnnounceDeliveryResult) => void;
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
      onDeliveryResult: () => {
        if (committedDelivery) {
          return;
        }
        // Platform identity is committed before transcript mirroring, which
        // may wait behind the requester's still-active SQLite writer.
        committedDelivery = { delivered: true, path: "direct", deliveredAt: Date.now() };
        params.onDeliveryResult?.(committedDelivery);
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

export type MessagingToolDeliveryTarget = Parameters<typeof sourceDeliveryTargetsMatch>[0];
export type SourceDeliveryTarget = Parameters<typeof sourceDeliveryTargetsMatch>[1];

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

export async function hasMessagingToolDeliveryToSource(
  result: MessagingToolDeliveryResult,
  deliveryTarget: SourceDeliveryTarget,
  options?: MessagingToolDeliveryMatchOptions,
): Promise<boolean> {
  const targets = Array.isArray(result.messagingToolSentTargets)
    ? result.messagingToolSentTargets
    : [];
  const sourceTargets: MessagingToolDeliveryTarget[] = [];
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
    // A provider-native conversation ID (for example Slack's D… DM channel)
    // can represent the configured source user without being textually equal.
    // Lookup failures are unverified evidence, not delivery failures.
    try {
      const equivalentTarget = await options.resolveEquivalentTarget(
        sourceTarget,
        deliveryTarget,
        options.signal,
      );
      if (
        equivalentTarget &&
        sourceDeliveryTargetsMatch({ ...sourceTarget, to: equivalentTarget }, deliveryTarget)
      ) {
        sourceTargets.push({ ...sourceTarget, to: equivalentTarget });
      }
    } catch {
      // Keep the completion owed when the provider cannot verify the recipient.
    }
  }
  if (options?.requireFinalReply) {
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
  }
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
}

export async function resolveMessagingToolDeliveryEvidence(params: {
  cfg: OpenClawConfig;
  requesterSessionKey: string;
  requesterAgentId?: string;
  result: MessagingToolDeliveryResult;
  deliveryTarget: SourceDeliveryTarget;
  signal?: AbortSignal;
  timeoutMs?: number;
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
  try {
    const resolveEquivalentTarget = (
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
      );
    const matchOptions = { resolveEquivalentTarget, signal };
    const hasFinalMessagingToolDelivery = await hasMessagingToolDeliveryToSource(
      params.result,
      params.deliveryTarget,
      { ...matchOptions, requireFinalReply: true },
    );
    return {
      hasFinalMessagingToolDelivery,
      hasMessagingToolDelivery:
        hasFinalMessagingToolDelivery ||
        (await hasMessagingToolDeliveryToSource(
          params.result,
          params.deliveryTarget,
          matchOptions,
        )),
    };
  } finally {
    clearTimeout(timer);
  }
}
