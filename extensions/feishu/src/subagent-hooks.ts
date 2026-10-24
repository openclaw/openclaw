import { normalizeOptionalLowercaseString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { buildFeishuConversationId, parseFeishuConversationId } from "./conversation-id.js";
import { normalizeFeishuTarget, stripFeishuProviderPrefix } from "./targets.js";
import { getFeishuThreadBindingManager } from "./thread-bindings.js";

type FeishuSubagentDeliveryTargetEvent = {
  expectsCompletionMessage?: boolean;
  requesterOrigin?: {
    channel?: string;
    accountId?: string;
    to?: string;
    threadId?: string | number;
  };
  childSessionKey: string;
  requesterSessionKey?: string;
};

type FeishuSubagentEndedEvent = {
  accountId?: string;
  targetSessionKey: string;
};

export function handleFeishuSubagentDeliveryTarget(event: FeishuSubagentDeliveryTargetEvent) {
  if (!event.expectsCompletionMessage) {
    return undefined;
  }
  const requesterChannel = normalizeOptionalLowercaseString(event.requesterOrigin?.channel);
  if (requesterChannel !== "feishu") {
    return undefined;
  }

  const { requesterOrigin, childSessionKey, requesterSessionKey } = event;
  const requesterAccountId = requesterOrigin?.accountId;
  function resolveMatchingChildBinding() {
    const manager = getFeishuThreadBindingManager(requesterAccountId);
    if (!manager) {
      return null;
    }
    const childBindings = manager.listBySessionKey(childSessionKey.trim());
    if (childBindings.length === 0) {
      return null;
    }

    const requesterTo = requesterOrigin?.to;
    const requesterThreadId = requesterOrigin?.threadId;
    const resolveFeishuRequesterConversation = (): {
      accountId: string;
      conversationId: string;
      parentConversationId?: string;
    } | null => {
      const rawTo = requesterTo?.trim();
      const withoutProviderPrefix = rawTo ? stripFeishuProviderPrefix(rawTo) : "";
      const normalizedTarget = rawTo ? normalizeFeishuTarget(rawTo) : null;
      const threadId =
        requesterThreadId != null && requesterThreadId !== ""
          ? String(requesterThreadId).trim()
          : "";
      const isChatTarget = /^(chat|group|channel):/i.test(withoutProviderPrefix);
      const parsedRequesterTopic =
        normalizedTarget && threadId && isChatTarget
          ? parseFeishuConversationId({
              conversationId: buildFeishuConversationId({
                chatId: normalizedTarget,
                scope: "group_topic",
                topicId: threadId,
              }),
              parentConversationId: normalizedTarget,
            })
          : null;
      const normalizedRequesterSessionKey = requesterSessionKey?.trim();
      if (normalizedRequesterSessionKey) {
        const existingBindings = manager.listBySessionKey(normalizedRequesterSessionKey);
        if (existingBindings.length === 1) {
          return existingBindings[0]!;
        }
        if (existingBindings.length > 1) {
          if (rawTo && normalizedTarget && !threadId && !isChatTarget) {
            const directMatches = existingBindings.filter(
              (entry) => entry.conversationId === normalizedTarget && !entry.parentConversationId,
            );
            if (directMatches.length === 1) {
              return directMatches[0]!;
            }
            return null;
          }
          if (parsedRequesterTopic) {
            const matchingTopicBindings = existingBindings.filter((entry) => {
              const parsed = parseFeishuConversationId({
                conversationId: entry.conversationId,
                parentConversationId: entry.parentConversationId,
              });
              return (
                parsed?.chatId === parsedRequesterTopic.chatId &&
                parsed?.topicId === parsedRequesterTopic.topicId
              );
            });
            if (matchingTopicBindings.length === 1) {
              return matchingTopicBindings[0]!;
            }
            return null;
          }
        }
      }

      if (!rawTo || !normalizedTarget) {
        return null;
      }

      if (threadId) {
        if (!isChatTarget) {
          return null;
        }
        return {
          accountId: manager.accountId,
          conversationId: buildFeishuConversationId({
            chatId: normalizedTarget,
            scope: "group_topic",
            topicId: threadId,
          }),
          parentConversationId: normalizedTarget,
        };
      }

      if (isChatTarget) {
        return null;
      }

      return {
        accountId: manager.accountId,
        conversationId: normalizedTarget,
      };
    };

    const requesterConversation = resolveFeishuRequesterConversation();
    if (requesterConversation) {
      const matched = childBindings.find(
        (entry) =>
          entry.accountId === requesterConversation.accountId &&
          entry.conversationId === requesterConversation.conversationId &&
          entry.parentConversationId === requesterConversation.parentConversationId,
      );
      if (matched) {
        return matched;
      }
    }

    return childBindings.length === 1 ? childBindings[0] : null;
  }

  const binding = resolveMatchingChildBinding();
  if (!binding) {
    return undefined;
  }

  const deliveryTo = binding.deliveryTo;
  const parsed = deliveryTo
    ? null
    : parseFeishuConversationId({
        conversationId: binding.conversationId,
        parentConversationId: binding.parentConversationId,
      });
  const threadId = deliveryTo ? binding.deliveryThreadId : parsed?.topicId;
  return {
    origin: {
      channel: "feishu" as const,
      accountId: binding.accountId,
      to:
        deliveryTo ||
        (parsed?.topicId
          ? `chat:${binding.parentConversationId || parsed.chatId}`
          : `user:${binding.conversationId}`),
      ...(threadId ? { threadId } : {}),
    },
  };
}

export function handleFeishuSubagentEnded(event: FeishuSubagentEndedEvent) {
  const manager = getFeishuThreadBindingManager(event.accountId);
  manager?.unbindBySessionKey(event.targetSessionKey);
}
