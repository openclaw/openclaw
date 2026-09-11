/**
 * Subagent announcement origin resolver.
 *
 * Merges requester and session delivery context while avoiding stale thread ids after retargeting.
 */
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { getLoadedChannelPluginForRead } from "../../../channels/plugins/registry-loaded.js";
import type { ChannelId } from "../../../channels/plugins/types.public.js";
import { deliveryContextFromConversation } from "../../../channels/route-projection.js";
import type { SessionEntry } from "../../../config/sessions/types.js";
import {
  stripOutboundTargetKindPrefix,
  stripTargetProviderPrefix,
} from "../../../infra/outbound/channel-target-prefix.js";
import type { ConversationRef } from "../../../infra/outbound/session-binding-service.js";
import type { SessionDeliveryRoute } from "../../../infra/session-delivery-queue-storage.js";
import { stringifyRouteThreadId } from "../../../plugin-sdk/channel-route.js";
import { normalizeAccountId } from "../../../routing/session-key.js";
import { deriveSessionChatTypeFromKey } from "../../../sessions/session-chat-type-shared.js";
import {
  deliveryContextFromSession,
  mergeDeliveryContext,
  normalizeDeliveryContext,
} from "../../../utils/delivery-context.shared.js";
import type { DeliveryContext } from "../../../utils/delivery-context.types.js";
import {
  INTERNAL_MESSAGE_CHANNEL,
  isDeliverableMessageChannel,
  isGatewayMessageChannel,
  isInternalMessageChannel,
  normalizeMessageChannel,
} from "../../../utils/message-channel.js";
import type { SpawnSubagentMode } from "../spawn/subagent-spawn.types.js";
import {
  createBoundDeliveryRouter,
  getGlobalHookRunner,
  resolveConversationIdFromTargets,
} from "./subagent-announce-delivery.runtime.js";
export type { DeliveryContext } from "../../../utils/delivery-context.types.js";

function normalizeAnnounceRouteTarget(
  context?: DeliveryContext,
  fallbackChannel?: string,
): { id: string; threadId?: string } | undefined {
  const rawTo = normalizeOptionalString(context?.to);
  if (!rawTo) {
    return undefined;
  }
  const channel = normalizeOptionalString(context?.channel ?? fallbackChannel);
  const messaging = channel
    ? getLoadedChannelPluginForRead(channel as ChannelId)?.messaging
    : undefined;
  const stripPrefixes = (value: string) =>
    stripOutboundTargetKindPrefix(stripTargetProviderPrefix(value, channel ?? ""), [
      "group",
      "channel",
    ]);
  const target = stripPrefixes(rawTo);
  const normalized = messaging?.normalizeTarget?.(target) ?? target;
  // Target normalizers can add prefixes; conversation IDs use the unqualified domain.
  const rawId = stripPrefixes(normalized);
  if (!rawId) {
    return undefined;
  }
  const conversation = messaging?.resolveSessionConversation?.({
    kind: inferDeliveryTargetChatType({ channel, to: rawTo }) === "group" ? "group" : "channel",
    rawId,
  });
  const id = normalizeOptionalString(conversation?.id);
  return {
    id: id ?? (messaging?.targetIdComparison === "lowercase" ? rawId.toLowerCase() : rawId),
    threadId: id ? normalizeOptionalString(conversation?.threadId) : undefined,
  };
}

function shouldStripThreadFromAnnounceFallback(
  normalizedRequester?: DeliveryContext,
  normalizedEntry?: DeliveryContext,
): boolean {
  if (
    !normalizedRequester?.to ||
    normalizedRequester.threadId != null ||
    normalizedEntry?.threadId == null
  ) {
    return false;
  }
  const requesterTarget = normalizeAnnounceRouteTarget(
    normalizedRequester,
    normalizedEntry?.channel,
  );
  const entryTarget = normalizeAnnounceRouteTarget(normalizedEntry, normalizedRequester.channel);
  if (requesterTarget && entryTarget) {
    return (
      requesterTarget.id !== entryTarget.id ||
      (requesterTarget.threadId !== undefined &&
        requesterTarget.threadId !== stringifyRouteThreadId(normalizedEntry.threadId))
    );
  }
  return false;
}

function mergeAnnounceDeliveryContext(
  primary?: DeliveryContext,
  fallback?: DeliveryContext,
): DeliveryContext | undefined {
  const normalizedPrimary = normalizeDeliveryContext(primary);
  const normalizedFallback = normalizeDeliveryContext(fallback);
  if (
    normalizedFallback &&
    shouldStripThreadFromAnnounceFallback(normalizedPrimary, normalizedFallback)
  ) {
    // A stored thread only applies to the same normalized route target.
    const { threadId: _ignore, ...rest } = normalizedFallback;
    return mergeDeliveryContext(normalizedPrimary, rest);
  }
  return mergeDeliveryContext(normalizedPrimary, normalizedFallback);
}

/** Resolve the delivery origin for a subagent completion announcement. */
export function resolveAnnounceOrigin(
  entry?: Pick<SessionEntry, "delivery">,
  requesterOrigin?: DeliveryContext,
): DeliveryContext | undefined {
  const normalizedRequester = normalizeDeliveryContext(requesterOrigin);
  const normalizedEntry = deliveryContextFromSession(entry);
  if (normalizedRequester?.channel && isInternalMessageChannel(normalizedRequester.channel)) {
    return mergeDeliveryContext(
      {
        accountId: normalizedRequester.accountId,
        threadId: normalizedRequester.threadId,
      },
      normalizedEntry,
    );
  }
  return mergeAnnounceDeliveryContext(normalizedRequester, normalizedEntry);
}

function resolveBoundConversationOrigin(params: {
  bindingConversation: ConversationRef & { parentConversationId?: string };
  requesterConversation?: ConversationRef;
  requesterOrigin?: DeliveryContext;
}): DeliveryContext {
  const conversation = params.bindingConversation;
  const conversationId = conversation.conversationId?.trim() ?? "";
  const parentConversationId = conversation.parentConversationId?.trim() ?? "";
  const requesterConversationId = params.requesterConversation?.conversationId?.trim() ?? "";
  const requesterTo = params.requesterOrigin?.to?.trim();
  const boundTarget = deliveryContextFromConversation(conversation);
  const inferredThreadId =
    boundTarget?.threadId ??
    (parentConversationId && parentConversationId !== conversationId ? conversationId : undefined);
  if (
    requesterTo &&
    conversationId &&
    requesterConversationId &&
    conversationId === requesterConversationId
  ) {
    return {
      channel: conversation.channel,
      accountId: conversation.accountId,
      to: requesterTo,
      threadId: inferredThreadId,
    };
  }
  return {
    channel: conversation.channel,
    accountId: conversation.accountId,
    to: boundTarget?.to,
    threadId: inferredThreadId,
  };
}

/** Resolve the bound or hook-provided external origin for a completed subagent. */
export async function resolveSubagentCompletionOrigin(params: {
  childSessionKey: string;
  requesterSessionKey: string;
  requesterOrigin?: DeliveryContext;
  childRunId?: string;
  spawnMode?: SpawnSubagentMode;
  expectsCompletionMessage: boolean;
}): Promise<DeliveryContext | undefined> {
  const requesterOrigin = normalizeDeliveryContext(params.requesterOrigin);
  const channel = normalizeOptionalLowercaseString(requesterOrigin?.channel);
  const to = requesterOrigin?.to?.trim();
  const accountId = normalizeAccountId(requesterOrigin?.accountId);
  const threadId =
    requesterOrigin?.threadId != null && requesterOrigin.threadId !== ""
      ? requesterOrigin.threadId
      : undefined;
  const conversationId =
    stringifyRouteThreadId(threadId) || resolveConversationIdFromTargets({ targets: [to] }) || "";
  const requesterConversation: ConversationRef | undefined =
    channel && conversationId ? { channel, accountId, conversationId } : undefined;
  const router = createBoundDeliveryRouter();
  for (const targetSessionKey of [params.requesterSessionKey, params.childSessionKey]) {
    const route = router.resolveDestination({
      eventKind: "task_completion",
      targetSessionKey,
      requester: requesterConversation,
      failClosed: true,
    });
    if (route.mode === "bound" && route.binding) {
      return mergeAnnounceDeliveryContext(
        resolveBoundConversationOrigin({
          bindingConversation: route.binding.conversation,
          requesterConversation,
          requesterOrigin,
        }),
        requesterOrigin,
      );
    }
  }

  const hookRunner = getGlobalHookRunner();
  if (!hookRunner?.hasHooks("subagent_delivery_target")) {
    return requesterOrigin;
  }
  try {
    const result = await hookRunner.runSubagentDeliveryTarget(
      {
        childSessionKey: params.childSessionKey,
        requesterSessionKey: params.requesterSessionKey,
        requesterOrigin,
        childRunId: params.childRunId,
        spawnMode: params.spawnMode,
        expectsCompletionMessage: params.expectsCompletionMessage,
      },
      {
        runId: params.childRunId,
        childSessionKey: params.childSessionKey,
        requesterSessionKey: params.requesterSessionKey,
      },
    );
    const hookOrigin = normalizeDeliveryContext(result?.origin);
    return !hookOrigin || (hookOrigin.channel && isInternalMessageChannel(hookOrigin.channel))
      ? requesterOrigin
      : mergeAnnounceDeliveryContext(hookOrigin, requesterOrigin);
  } catch {
    return requesterOrigin;
  }
}

function stripNonDeliverableChannel(context?: DeliveryContext): DeliveryContext | undefined {
  const normalized = normalizeDeliveryContext(context);
  if (!normalized?.channel) {
    return normalized;
  }
  const channel = normalizeMessageChannel(normalized.channel);
  if (!channel || isDeliverableMessageChannel(channel)) {
    return normalized;
  }
  const { channel: _channel, ...rest } = normalized;
  return normalizeDeliveryContext(rest);
}

/** Resolve normalized session and external completion origins once for every delivery path. */
export function resolveCompletionDeliveryOrigins(params: {
  expectsCompletionMessage: boolean;
  completionDirectOrigin?: DeliveryContext;
  directOrigin?: DeliveryContext;
  requesterSessionOrigin?: DeliveryContext;
}) {
  const directOrigin = normalizeDeliveryContext(params.directOrigin);
  const requesterSessionOrigin = normalizeDeliveryContext(params.requesterSessionOrigin);
  const completionFallbackOrigin = mergeAnnounceDeliveryContext(
    directOrigin,
    requesterSessionOrigin,
  );
  return {
    directOrigin,
    requesterSessionOrigin,
    effectiveDirectOrigin: params.expectsCompletionMessage
      ? mergeAnnounceDeliveryContext(
          stripNonDeliverableChannel(params.completionDirectOrigin),
          completionFallbackOrigin,
        )
      : directOrigin,
  };
}

/** Infer whether a normalized delivery target addresses a direct, group, or channel chat. */
export function inferDeliveryTargetChatType(target: {
  channel?: string;
  to?: string;
}): "direct" | "group" | "channel" | undefined {
  const normalizedTo = normalizeOptionalLowercaseString(target.to);
  if (!normalizedTo) {
    return undefined;
  }
  if (
    normalizedTo.startsWith("dm:") ||
    normalizedTo.startsWith("direct:") ||
    normalizedTo.startsWith("user:") ||
    normalizedTo.includes(":dm:") ||
    normalizedTo.includes(":direct:")
  ) {
    return "direct";
  }
  if (normalizedTo.startsWith("channel:") || normalizedTo.startsWith("thread:")) {
    return "channel";
  }
  if (normalizedTo.startsWith("group:")) {
    return "group";
  }
  const channel = normalizeMessageChannel(target.channel);
  return channel
    ? getLoadedChannelPluginForRead(channel as ChannelId)?.messaging?.inferTargetChatType?.({
        to: target.to ?? "",
      })
    : undefined;
}

/** Resolve the durable generated-media handoff route from the canonical completion origin. */
export function resolveGeneratedMediaSessionDeliveryRoute(params: {
  sessionKey: string;
  completionDirectOrigin?: DeliveryContext;
  directOrigin?: DeliveryContext;
  requesterSessionOrigin?: DeliveryContext;
}): { route: SessionDeliveryRoute; deliveryContext?: DeliveryContext } {
  const { effectiveDirectOrigin: deliveryContext } = resolveCompletionDeliveryOrigins({
    ...params,
    expectsCompletionMessage: true,
  });
  const channel = normalizeMessageChannel(deliveryContext?.channel);
  const to = deliveryContext?.to?.trim();
  const inferredRouteChatType = inferDeliveryTargetChatType({ channel, to });
  const derivedChatType = deriveSessionChatTypeFromKey(params.sessionKey);
  const chatType =
    inferredRouteChatType ??
    (!derivedChatType || derivedChatType === "unknown" ? "direct" : derivedChatType);
  if (channel && isGatewayMessageChannel(channel) && to) {
    return {
      route: {
        channel,
        to,
        ...(deliveryContext?.accountId ? { accountId: deliveryContext.accountId } : {}),
        ...(deliveryContext?.threadId != null
          ? { threadId: stringifyRouteThreadId(deliveryContext.threadId) }
          : {}),
        chatType,
      },
      deliveryContext,
    };
  }
  return {
    route: { channel: INTERNAL_MESSAGE_CHANNEL, to: params.sessionKey, chatType },
    deliveryContext,
  };
}
