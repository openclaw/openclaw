import { resolveReactionMessageId } from "openclaw/plugin-sdk/channel-actions";
import type {
  ChannelMessageActionContext,
  ChannelToolSend,
} from "openclaw/plugin-sdk/channel-contract";
import { stripChannelTargetPrefix } from "openclaw/plugin-sdk/channel-core";
import { isSingleUseReplyToMode } from "openclaw/plugin-sdk/reply-reference";
import { isRecord, normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { MSTeamsConfig } from "../runtime-api.js";
import { extractMSTeamsConversationMessageId, normalizeMSTeamsConversationId } from "./inbound.js";
import { resolveMSTeamsReplyPolicy, resolveMSTeamsRouteConfig } from "./policy.js";
import { parseMSTeamsTeamChannelInput } from "./resolve-allowlist.js";

/** Normalize Teams conversation targets for equality (strips `conversation:` and `;messageid=`). */
function normalizeMSTeamsThreadingTarget(raw: string | undefined): string | undefined {
  const value = normalizeOptionalString(raw);
  if (!value) {
    return undefined;
  }
  return normalizeMSTeamsConversationId(stripChannelTargetPrefix(value, "conversation"));
}

function extractMSTeamsResultConversationId(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const direct = normalizeOptionalString(value.conversationId);
  if (direct) {
    return direct;
  }
  const receipt = isRecord(value.receipt) ? value.receipt : undefined;
  if (!receipt) {
    return undefined;
  }
  const candidates = [
    ...(Array.isArray(receipt.raw) ? receipt.raw : []),
    ...(Array.isArray(receipt.parts)
      ? receipt.parts.map((part) => (isRecord(part) ? part.raw : undefined))
      : []),
  ];
  for (const candidate of candidates) {
    if (!isRecord(candidate)) {
      continue;
    }
    const conversationId = normalizeOptionalString(candidate.conversationId);
    if (conversationId) {
      return conversationId;
    }
  }
  return undefined;
}

/** Recover the actual Teams conversation resolved by a successful tool send. */
export function extractMSTeamsToolSendResult(result: unknown): ChannelToolSend | null {
  const details = isRecord(result) && isRecord(result.details) ? result.details : undefined;
  const deliveryResult = details && isRecord(details.result) ? details.result : undefined;
  const conversationId = extractMSTeamsResultConversationId(deliveryResult);
  if (!conversationId) {
    return null;
  }
  const normalizedConversationId = normalizeMSTeamsConversationId(
    stripChannelTargetPrefix(conversationId, "conversation"),
  );
  return normalizedConversationId ? { to: `conversation:${normalizedConversationId}` } : null;
}

export function msteamsContextTargetsMatch(
  target: string,
  context: {
    currentChannelId?: string;
    currentMessagingTarget?: string;
  },
): boolean {
  const normalizedTarget = normalizeMSTeamsThreadingTarget(target);
  if (!normalizedTarget) {
    return false;
  }
  const currentChannel = normalizeMSTeamsThreadingTarget(context.currentChannelId);
  if (currentChannel && currentChannel === normalizedTarget) {
    return true;
  }
  const currentMessaging = normalizeMSTeamsThreadingTarget(context.currentMessagingTarget);
  return Boolean(currentMessaging && currentMessaging === normalizedTarget);
}

export function resolveMSTeamsActionMessage(
  ctx: Pick<ChannelMessageActionContext, "params" | "toolContext">,
  to: string,
  allowCurrentMessageIdFallback = false,
): { messageId: string; threadRootId?: string } {
  const canUseCurrentMessageId =
    allowCurrentMessageIdFallback &&
    msteamsContextTargetsMatch(to, {
      currentChannelId: ctx.toolContext?.currentChannelId ?? undefined,
      currentMessagingTarget:
        normalizeOptionalString(ctx.toolContext?.currentGraphChannelId) ??
        normalizeOptionalString(ctx.toolContext?.currentMessagingTarget),
    });
  const resolved = canUseCurrentMessageId
    ? resolveReactionMessageId({
        args: ctx.params,
        toolContext: { currentMessageId: ctx.toolContext?.currentMessageId ?? undefined },
      })
    : (normalizeOptionalString(ctx.params.messageId) ?? "");
  const messageId = resolved == null ? "" : String(resolved).trim();
  // Graph addresses a channel reply only beneath its thread root. Carry the root for
  // the current message; never infer one for another explicit message id.
  const currentMessageId = ctx.toolContext?.currentMessageId;
  const threadRootId =
    canUseCurrentMessageId &&
    ctx.toolContext?.currentChatType === "channel" &&
    currentMessageId != null &&
    messageId === String(currentMessageId).trim()
      ? normalizeOptionalString(ctx.toolContext.currentThreadTs)
      : undefined;
  return { messageId, ...(threadRootId ? { threadRootId } : {}) };
}

export function resolveMSTeamsAutoThreadId(params: {
  cfg?: MSTeamsConfig;
  to: string;
  toolContext?: {
    currentChannelId?: string;
    currentMessagingTarget?: string;
    currentGraphChannelId?: string;
    currentThreadTs?: string;
    replyToMode?: "off" | "first" | "all" | "batched";
    hasRepliedRef?: { value: boolean };
  };
}): string | undefined {
  const explicitThreadId = extractMSTeamsConversationMessageId(params.to);
  if (explicitThreadId) {
    return explicitThreadId;
  }
  const context = params.toolContext;
  if (!context?.currentChannelId && !context?.currentMessagingTarget) {
    return undefined;
  }
  if (!msteamsContextTargetsMatch(params.to, context)) {
    return undefined;
  }
  const graphTarget = context.currentGraphChannelId ?? context.currentMessagingTarget;
  const { team, channel } = graphTarget
    ? parseMSTeamsTeamChannelInput(graphTarget)
    : { team: undefined, channel: undefined };
  const routeConfig = resolveMSTeamsRouteConfig({
    cfg: params.cfg,
    teamId: team,
    conversationId: channel,
    allowNameMatching: false,
  });
  const { replyStyle } = resolveMSTeamsReplyPolicy({
    isDirectMessage: false,
    globalConfig: params.cfg,
    teamConfig: routeConfig.teamConfig,
    channelConfig: routeConfig.channelConfig,
  });
  if (replyStyle === "top-level") {
    return undefined;
  }
  if (!context.currentThreadTs) {
    return undefined;
  }
  if (context.replyToMode !== "all" && !isSingleUseReplyToMode(context.replyToMode ?? "off")) {
    return undefined;
  }
  if (isSingleUseReplyToMode(context.replyToMode ?? "off") && context.hasRepliedRef?.value) {
    return undefined;
  }
  return context.currentThreadTs;
}
