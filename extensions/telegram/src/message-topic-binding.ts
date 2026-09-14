// Telegram provider-owned authorization for message mutations in forum topics.
import { normalizeAccountId, normalizeOptionalAccountId } from "openclaw/plugin-sdk/account-core";
import type {
  ChannelMessageActionContext,
  ChannelThreadingToolContext,
} from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { parseStrictPositiveInteger } from "openclaw/plugin-sdk/number-runtime";
import { resolveStorePath } from "openclaw/plugin-sdk/session-store-runtime";
import { resolveTelegramAccountOwnerAgentId } from "./account-owner.js";
import { resolveDefaultTelegramAccountId } from "./accounts.js";
import { resolveTelegramMessageCacheScope } from "./message-cache-persistence.js";
import {
  createTelegramMessageCache,
  hasProviderObservedTelegramThreadBinding,
} from "./message-cache.js";
import { parseTelegramTarget } from "./targets.js";

type ConversationReadInvocationOrigin = NonNullable<
  ChannelMessageActionContext["conversationReadOrigin"]
>;

export type TelegramMessageMutationContext = {
  sessionKey?: string | null;
  sessionId?: string | null;
  conversationReadOrigin?: ConversationReadInvocationOrigin;
  requesterAccountId?: string | null;
  toolContext?: ChannelThreadingToolContext;
};

/** Cached history requires exact host-owned conversation authority. */
export function resolveTelegramCachedHistoryScope(params: {
  chatId?: string | number;
  threadId?: number;
  cfg: OpenClawConfig;
  accountId?: string | null;
  context?: TelegramMessageMutationContext;
}): { accountId: string; chatId: string; threadId?: number } {
  const origin = params.context?.conversationReadOrigin;
  if (
    origin !== "direct-operator" &&
    (origin !== "delegated" || !params.context?.sessionKey?.trim())
  ) {
    throw new Error(CONVERSATION_BINDING_ERROR);
  }
  const chatId = resolveTelegramConversationReadChatId(params);
  const target = parseTelegramTarget(String(params.chatId ?? chatId));
  const current = resolveCurrentTelegramConversation(params.context?.toolContext, chatId);
  const currentTargets = [
    params.context?.toolContext?.currentChannelId,
    params.context?.toolContext?.currentMessagingTarget,
  ];
  // Direct-message topics must not collapse into forum or topicless reads.
  if (
    target.directMessagesTopicId !== undefined ||
    currentTargets.some(
      (value) => value && parseTelegramTarget(value).directMessagesTopicId !== undefined,
    )
  ) {
    throw new Error("Telegram cached history does not support direct-message topics.");
  }
  const threadId =
    params.threadId ??
    target.messageThreadId ??
    (origin === "delegated" ? current.threadId : undefined);
  if (
    !/^-?\d+$/.test(chatId) ||
    (params.threadId !== undefined &&
      target.messageThreadId !== undefined &&
      params.threadId !== target.messageThreadId) ||
    (origin === "delegated" && threadId !== current.threadId)
  ) {
    throw new Error(CONVERSATION_BINDING_ERROR);
  }
  const accountId =
    origin === "delegated"
      ? resolveMatchingTelegramRequesterAccount(params)
      : normalizeOptionalAccountId(params.accountId ?? resolveDefaultTelegramAccountId(params.cfg));
  if (!accountId) {
    throw new Error(CONVERSATION_BINDING_ERROR);
  }
  return { accountId, chatId, ...(threadId !== undefined ? { threadId } : {}) };
}

const TOPIC_BINDING_ERROR =
  "Delegated Telegram message mutation requires a provider-observed binding to the exact current topic and account.";
const CONVERSATION_BINDING_ERROR =
  "Delegated Telegram conversation read requires the exact current chat and account.";

function rejectUnboundTopicMutation(): never {
  throw new Error(TOPIC_BINDING_ERROR);
}

type CurrentTelegramConversation = {
  hasThreadContext: boolean;
  matchesChat: boolean;
  threadId?: number;
};

function resolveCurrentTelegramConversation(
  toolContext: ChannelThreadingToolContext | undefined,
  chatId: string,
): CurrentTelegramConversation {
  if (toolContext?.currentChannelProvider?.trim().toLowerCase() !== "telegram") {
    return { hasThreadContext: false, matchesChat: false };
  }
  const targets = [toolContext.currentChannelId, toolContext.currentMessagingTarget].filter(
    (value): value is string => typeof value === "string" && Boolean(value.trim()),
  );
  const parsedTargets = targets.map((value) => parseTelegramTarget(value));
  const threadIds = [
    ...parsedTargets.map((target) => target.messageThreadId),
    parseStrictPositiveInteger(toolContext.currentThreadTs),
  ].filter((value): value is number => value !== undefined);
  const threadId = threadIds[0];
  const matchesChat =
    targets.length > 0 &&
    parsedTargets.every((target) => target.chatId === chatId) &&
    (threadId === undefined || threadIds.every((value) => value === threadId));
  return {
    hasThreadContext: threadIds.length > 0,
    matchesChat,
    ...(threadId !== undefined ? { threadId } : {}),
  };
}

function resolveMatchingTelegramRequesterAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  context?: TelegramMessageMutationContext;
}): string | undefined {
  const accountId = normalizeOptionalAccountId(
    params.accountId ?? resolveDefaultTelegramAccountId(params.cfg),
  );
  const requesterAccountId = normalizeOptionalAccountId(params.context?.requesterAccountId);
  return accountId &&
    requesterAccountId &&
    normalizeAccountId(accountId) === normalizeAccountId(requesterAccountId)
    ? accountId
    : undefined;
}

export function resolveTelegramConversationReadChatId(params: {
  chatId?: string | number;
  cfg: OpenClawConfig;
  accountId?: string | null;
  context?: TelegramMessageMutationContext;
}): string {
  const currentTarget =
    params.context?.toolContext?.currentChannelId ??
    params.context?.toolContext?.currentMessagingTarget;
  const requestedTarget = params.chatId ?? currentTarget;
  if (requestedTarget == null || !String(requestedTarget).trim()) {
    throw new Error("Telegram conversation read requires a chatId or current conversation.");
  }
  const target = parseTelegramTarget(String(requestedTarget));
  if (params.context?.conversationReadOrigin === "direct-operator") {
    return target.chatId;
  }
  const currentConversation = resolveCurrentTelegramConversation(
    params.context?.toolContext,
    target.chatId,
  );
  if (
    !resolveMatchingTelegramRequesterAccount(params) ||
    !currentConversation.matchesChat ||
    (target.messageThreadId !== undefined &&
      target.messageThreadId !== currentConversation.threadId)
  ) {
    throw new Error(CONVERSATION_BINDING_ERROR);
  }
  return target.chatId;
}

export async function resolveTelegramMessageMutationChatId(params: {
  chatId: string | number;
  messageId: number;
  cfg: OpenClawConfig;
  accountId?: string | null;
  context?: TelegramMessageMutationContext;
}): Promise<string | number> {
  const target = parseTelegramTarget(String(params.chatId));
  if (params.context?.conversationReadOrigin === "direct-operator") {
    return target.messageThreadId === undefined ? params.chatId : target.chatId;
  }

  const currentConversation = resolveCurrentTelegramConversation(
    params.context?.toolContext,
    target.chatId,
  );
  const selectedAccountId = resolveMatchingTelegramRequesterAccount(params);
  if (!selectedAccountId || !currentConversation.matchesChat) {
    return rejectUnboundTopicMutation();
  }

  const threadId = target.messageThreadId ?? currentConversation.threadId;
  if (threadId === undefined && !currentConversation.hasThreadContext) {
    return target.chatId;
  }
  if (threadId === undefined || currentConversation.threadId !== threadId) {
    return rejectUnboundTopicMutation();
  }

  const currentMessageId = parseStrictPositiveInteger(
    params.context?.toolContext?.currentMessageId,
  );
  // Current-message context is server-owned. Earlier messages need the
  // persisted provider observation so a sibling topic cannot borrow the ID.
  if (currentMessageId === params.messageId) {
    return target.chatId;
  }

  const cache = createTelegramMessageCache({
    scope: resolveTelegramMessageCacheScope(
      resolveStorePath(params.cfg.session?.store, {
        agentId: resolveTelegramAccountOwnerAgentId({
          cfg: params.cfg,
          accountId: selectedAccountId,
        }),
      }),
    ),
  });
  const cached = await cache.get({
    accountId: selectedAccountId,
    chatId: target.chatId,
    messageId: String(params.messageId),
  });
  if (!hasProviderObservedTelegramThreadBinding(cached, threadId)) {
    return rejectUnboundTopicMutation();
  }
  return target.chatId;
}
