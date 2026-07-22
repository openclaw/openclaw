// Telegram provider-owned authorization for message mutations in forum topics.
import { normalizeAccountId, normalizeOptionalAccountId } from "openclaw/plugin-sdk/account-core";
import type {
  ChannelMessageActionContext,
  ChannelThreadingToolContext,
} from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { parseStrictPositiveInteger } from "openclaw/plugin-sdk/number-runtime";
import { resolveStorePath } from "openclaw/plugin-sdk/session-store-runtime";
import { resolveDefaultTelegramAccountId } from "./accounts.js";
import {
  createTelegramMessageCache,
  hasProviderObservedTelegramThreadBinding,
  resolveTelegramMessageCacheScope,
} from "./message-cache.js";
import { parseTelegramTarget } from "./targets.js";

type ConversationReadInvocationOrigin = NonNullable<
  ChannelMessageActionContext["conversationReadOrigin"]
>;

export type TelegramMessageMutationContext = {
  conversationReadOrigin?: ConversationReadInvocationOrigin;
  requesterAccountId?: string | null;
  toolContext?: ChannelThreadingToolContext;
};

const TOPIC_BINDING_ERROR =
  "Delegated Telegram message mutation requires a provider-observed binding to the exact current topic and account.";

function rejectUnboundTopicMutation(): never {
  throw new Error(TOPIC_BINDING_ERROR);
}

function matchesCurrentTopic(
  toolContext: ChannelThreadingToolContext | undefined,
  chatId: string,
  threadId: number,
): boolean {
  if (toolContext?.currentChannelProvider?.trim().toLowerCase() !== "telegram") {
    return false;
  }
  const targets = [toolContext.currentChannelId, toolContext.currentMessagingTarget].filter(
    (value): value is string => typeof value === "string" && Boolean(value.trim()),
  );
  return (
    targets.length > 0 &&
    targets.every((value) => {
      const current = parseTelegramTarget(value);
      return current.chatId === chatId && current.messageThreadId === threadId;
    })
  );
}

function hasCurrentTelegramTopic(toolContext: ChannelThreadingToolContext | undefined): boolean {
  if (toolContext?.currentChannelProvider?.trim().toLowerCase() !== "telegram") {
    return false;
  }
  return [toolContext.currentChannelId, toolContext.currentMessagingTarget].some(
    (value) =>
      typeof value === "string" && parseTelegramTarget(value).messageThreadId !== undefined,
  );
}

export async function resolveTelegramMessageMutationChatId(params: {
  chatId: string | number;
  messageId: number;
  cfg: OpenClawConfig;
  accountId?: string | null;
  context?: TelegramMessageMutationContext;
}): Promise<string | number> {
  const target = parseTelegramTarget(String(params.chatId));
  if (target.messageThreadId === undefined) {
    // A topicless spelling must not bypass the provider check if this operation
    // escaped shared normalization while still carrying trusted topic context.
    if (
      params.context?.conversationReadOrigin !== "direct-operator" &&
      hasCurrentTelegramTopic(params.context?.toolContext)
    ) {
      return rejectUnboundTopicMutation();
    }
    return params.chatId;
  }
  if (params.context?.conversationReadOrigin === "direct-operator") {
    return target.chatId;
  }

  const selectedAccountId = normalizeOptionalAccountId(
    params.accountId ?? resolveDefaultTelegramAccountId(params.cfg),
  );
  const requesterAccountId = normalizeOptionalAccountId(params.context?.requesterAccountId);
  if (
    !selectedAccountId ||
    !requesterAccountId ||
    normalizeAccountId(selectedAccountId) !== normalizeAccountId(requesterAccountId) ||
    !matchesCurrentTopic(params.context?.toolContext, target.chatId, target.messageThreadId)
  ) {
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
    scope: resolveTelegramMessageCacheScope(resolveStorePath(params.cfg.session?.store)),
  });
  const cached = await cache.get({
    accountId: selectedAccountId,
    chatId: target.chatId,
    messageId: String(params.messageId),
  });
  if (!hasProviderObservedTelegramThreadBinding(cached, target.messageThreadId)) {
    return rejectUnboundTopicMutation();
  }
  return target.chatId;
}
