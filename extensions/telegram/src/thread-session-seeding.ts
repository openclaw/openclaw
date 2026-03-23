import type { OpenClawConfig } from "../../../src/config/config.js";
import {
  mergeSessionEntry,
  resolveSessionStoreEntry,
  resolveStorePath,
  type SessionEntry,
  updateSessionStore,
} from "../../../src/config/sessions.js";
import { buildAgentSessionKey } from "../../../src/routing/resolve-route.js";
import { DEFAULT_ACCOUNT_ID, resolveThreadSessionKeys } from "../../../src/routing/session-key.js";
import { seedSessionEntryFromFutureThreadDefaults } from "../../../src/sessions/future-thread-defaults.js";
import { resolveFutureThreadParentSessionKey } from "../../../src/sessions/session-key-utils.js";
import { resolveTelegramDirectPeerId, resolveTelegramInboundThreadId } from "./bot/helpers.js";
import { resolveTelegramConversationRoute } from "./conversation-route.js";

type TelegramTopicCreateCarrier = {
  message_id?: number;
  message_thread_id?: number;
  direct_messages_topic?: { topic_id?: number | string | null } | null;
  reply_to_message?: {
    message_thread_id?: number;
    direct_messages_topic?: { topic_id?: number | string | null } | null;
  } | null;
  reply_to?: {
    forum_topic?: boolean;
    reply_to_top_id?: number | string | null;
  } | null;
  forum_topic_created?: unknown;
  is_topic_message?: boolean;
};

function resolveInboundThreadId(params: {
  message: TelegramTopicCreateCarrier;
  resolvedThreadId?: number;
  dmThreadId?: number;
}) {
  return (
    params.dmThreadId ??
    params.resolvedThreadId ??
    resolveTelegramInboundThreadId(
      params.message as Parameters<typeof resolveTelegramInboundThreadId>[0],
    )
  );
}

export function isTelegramTopicCreateServiceMessage(params: {
  message: TelegramTopicCreateCarrier;
  isGroup: boolean;
  resolvedThreadId?: number;
  dmThreadId?: number;
}) {
  if (params.message.forum_topic_created != null) {
    return true;
  }

  if (params.isGroup) {
    return false;
  }

  const threadId = resolveInboundThreadId(params);
  if (threadId == null) {
    return false;
  }

  const messageId = params.message.message_id;
  if (typeof messageId !== "number" || messageId <= 0) {
    return false;
  }

  // Telegram DM threaded mode uses the topic anchor as the thread id. When a
  // private topic is created, the first system/anchor message points at its
  // own thread. Normal messages inside an already-existing topic always get a
  // newer message_id, so they must not trip the seed path.
  if (messageId !== threadId) {
    return false;
  }

  // `is_topic_message` is the Bot API signal for topic-scoped private
  // messages. Keep the fallback for relayed payloads that only preserve the
  // anchor/thread identity pair.
  return params.message.is_topic_message === true || params.dmThreadId != null;
}

function shouldUsePerAccountDmFallback(
  route: ReturnType<typeof resolveTelegramConversationRoute>["route"],
) {
  return route.accountId !== DEFAULT_ACCOUNT_ID && route.matchedBy === "default";
}

function applySeededFutureThreadDefaults(params: {
  store: Record<string, SessionEntry>;
  sessionKey: string;
  parentSessionKey: string | null;
  childThreadId?: string | number | null;
}) {
  const resolved = resolveSessionStoreEntry({
    store: params.store,
    sessionKey: params.sessionKey,
  });
  if (resolved.existing) {
    return { created: false, sessionKey: resolved.normalizedKey };
  }

  // Create a real SessionEntry immediately so pre-created topics stop looking
  // "brand new" later when their first user message arrives.
  const entry = mergeSessionEntry(undefined, {});
  const parentEntry = params.parentSessionKey ? params.store[params.parentSessionKey] : undefined;

  // Snapshot parent defaults at topic-creation time. This is the whole point:
  // a topic that already exists must not pick up a newer parent default later
  // just because its first real message arrives after the change.
  seedSessionEntryFromFutureThreadDefaults({
    entry,
    parentEntry,
    childThreadId: params.childThreadId,
  });

  params.store[resolved.normalizedKey] = entry;
  for (const legacyKey of resolved.legacyKeys) {
    delete params.store[legacyKey];
  }
  return { created: true, sessionKey: resolved.normalizedKey };
}

export async function seedTelegramThreadSessionOnTopicCreate(params: {
  cfg: OpenClawConfig;
  accountId: string;
  chatId: number | string;
  isGroup: boolean;
  senderId?: string | null;
  resolvedThreadId?: number;
  dmThreadId?: number;
  topicAgentId?: string | null;
}): Promise<{ created: boolean; sessionKey: string; parentSessionKey: string | null } | null> {
  const replyThreadId = params.resolvedThreadId ?? params.dmThreadId;
  if (replyThreadId == null) {
    return null;
  }

  const resolvedRoute = resolveTelegramConversationRoute({
    cfg: params.cfg,
    accountId: params.accountId,
    chatId: params.chatId,
    isGroup: params.isGroup,
    resolvedThreadId: params.resolvedThreadId,
    replyThreadId,
    senderId: params.senderId ?? undefined,
    topicAgentId: params.topicAgentId,
  });
  const route = resolvedRoute.route;
  if (params.isGroup && shouldUsePerAccountDmFallback(route)) {
    return null;
  }

  // Telegram forum groups already encode the topic in the peer id, but
  // private threaded-mode DMs still use a main-scoped base session and only
  // append the topic id as a thread suffix.
  const baseSessionKey =
    !params.isGroup && shouldUsePerAccountDmFallback(route)
      ? buildAgentSessionKey({
          agentId: route.agentId,
          channel: "telegram",
          accountId: route.accountId,
          peer: {
            kind: "direct",
            id: resolveTelegramDirectPeerId({
              chatId: params.chatId,
              senderId: params.senderId ?? undefined,
            }),
          },
          dmScope: "per-account-channel-peer",
          identityLinks: params.cfg.session?.identityLinks,
        }).toLowerCase()
      : route.sessionKey;
  const sessionKey =
    params.dmThreadId != null
      ? resolveThreadSessionKeys({
          baseSessionKey,
          threadId: `${params.chatId}:${params.dmThreadId}`,
        }).sessionKey
      : baseSessionKey;
  const parentSessionKey = resolveFutureThreadParentSessionKey({
    sessionKey,
    channelHint: "telegram",
  });
  const storePath = resolveStorePath(params.cfg.session?.store, {
    agentId: route.agentId,
  });

  let result: { created: boolean; sessionKey: string } | undefined;
  await updateSessionStore(
    storePath,
    (store) => {
      result = applySeededFutureThreadDefaults({
        store,
        sessionKey,
        parentSessionKey,
        childThreadId: replyThreadId,
      });
      return result;
    },
    { activeSessionKey: sessionKey },
  );

  if (!result) {
    return null;
  }
  return { ...result, parentSessionKey };
}
