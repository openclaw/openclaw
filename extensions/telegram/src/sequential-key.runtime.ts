import { hasControlCommand } from "openclaw/plugin-sdk/command-detection";
import type { OpenClawConfig, TelegramGroupConfig } from "openclaw/plugin-sdk/config-types";
import type { TelegramTopicConfig } from "openclaw/plugin-sdk/config-types";
import { resolveThreadSessionKeys } from "openclaw/plugin-sdk/routing";
import {
  extractTelegramLocation,
  getTelegramTextParts,
  resolveTelegramPrimaryMedia,
} from "./bot/body-helpers.js";
import { resolveTelegramForumThreadId } from "./bot/helpers.js";
import {
  resolveTelegramConversationBaseSessionKey,
  resolveTelegramConversationRoute,
} from "./conversation-route.js";
import { isReplyRunActiveForSessionKey } from "./reply-run-runtime.js";
import { getTelegramSequentialKey, type TelegramSequentialKeyContext } from "./sequential-key.js";

type ResolveTelegramGroupConfig = (
  chatId: string | number,
  messageThreadId?: number,
) => { groupConfig?: TelegramGroupConfig; topicConfig?: TelegramTopicConfig };

type CreateTelegramSequentialKeyParams = {
  accountId: string;
  loadRuntimeConfig: () => OpenClawConfig;
  resolveTelegramGroupConfig: ResolveTelegramGroupConfig;
};

function resolveBusySessionLane(
  ctx: TelegramSequentialKeyContext,
  params: CreateTelegramSequentialKeyParams,
): string | undefined {
  const msg =
    ctx.message ??
    ctx.channelPost ??
    ctx.editedChannelPost ??
    ctx.update?.message ??
    ctx.update?.edited_message ??
    ctx.update?.channel_post ??
    ctx.update?.edited_channel_post;
  const chatId = msg?.chat?.id ?? ctx.chat?.id;
  if (!msg || typeof chatId !== "number" || msg.chat?.type === "channel") {
    return undefined;
  }

  const rawText = getTelegramTextParts(msg).text.trim();
  const hasTurnContent =
    Boolean(rawText) ||
    Boolean(extractTelegramLocation(msg)) ||
    Boolean(resolveTelegramPrimaryMedia(msg));
  if (!hasTurnContent) {
    return undefined;
  }

  const cfg = params.loadRuntimeConfig();
  if (
    rawText &&
    hasControlCommand(rawText, cfg, ctx.me?.username ? { botUsername: ctx.me.username } : undefined)
  ) {
    return undefined;
  }

  const isGroup = msg.chat?.type === "group" || msg.chat?.type === "supergroup";
  const isForum = msg.chat?.is_forum === true || msg.is_topic_message === true;
  const resolvedThreadId = isGroup
    ? resolveTelegramForumThreadId({
        isForum,
        messageThreadId: msg.message_thread_id,
      })
    : undefined;
  const dmThreadId = !isGroup ? msg.message_thread_id : undefined;
  const topicThreadId = resolvedThreadId ?? dmThreadId;
  const { topicConfig } = params.resolveTelegramGroupConfig(chatId, topicThreadId);
  const senderId = msg.from?.id;
  const { route } = resolveTelegramConversationRoute({
    cfg,
    accountId: params.accountId,
    chatId,
    isGroup,
    resolvedThreadId,
    replyThreadId: topicThreadId,
    senderId,
    topicAgentId: topicConfig?.agentId,
  });
  const baseSessionKey = resolveTelegramConversationBaseSessionKey({
    cfg,
    route,
    chatId,
    isGroup,
    senderId,
  });
  const threadKeys =
    dmThreadId != null
      ? resolveThreadSessionKeys({ baseSessionKey, threadId: `${chatId}:${dmThreadId}` })
      : null;
  const sessionKey = threadKeys?.sessionKey ?? baseSessionKey;
  return isReplyRunActiveForSessionKey(sessionKey)
    ? `telegram:session-control:${sessionKey}`
    : undefined;
}

export function createTelegramSequentialKey(params: CreateTelegramSequentialKeyParams) {
  return (ctx: TelegramSequentialKeyContext): string => {
    const baseKey = getTelegramSequentialKey(ctx);
    if (baseKey.endsWith(":control") || baseKey.endsWith(":approval")) {
      return baseKey;
    }
    if (baseKey.endsWith(":btw") || baseKey.includes(":btw:")) {
      return baseKey;
    }
    return resolveBusySessionLane(ctx, params) ?? baseKey;
  };
}
