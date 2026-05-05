import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import {
  resolveRuntimeConversationBindingRoute,
  type RuntimeConversationBindingRouteResult,
} from "openclaw/plugin-sdk/conversation-runtime";
import { resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import { resolveThreadSessionKeys } from "openclaw/plugin-sdk/routing";
import {
  loadSessionStore,
  resolveSessionStoreEntry,
  resolveStorePath,
} from "openclaw/plugin-sdk/session-store-runtime";
import { resolveSlackReplyToMode } from "../../account-reply-mode.js";
import type { ResolvedSlackAccount } from "../../accounts.js";
import { resolveSlackThreadContext } from "../../threading.js";
import type { SlackMessageEvent } from "../../types.js";

export type SlackRoutingContextDeps = {
  cfg: OpenClawConfig;
  teamId: string;
  threadInheritParent: boolean;
  threadHistoryScope: "thread" | "channel";
};

export type SlackRoutingContext = {
  route: ReturnType<typeof resolveAgentRoute>;
  runtimeBinding: RuntimeConversationBindingRouteResult["bindingRecord"];
  chatType: "direct" | "group" | "channel";
  replyToMode: ReturnType<typeof resolveSlackReplyToMode>;
  threadContext: ReturnType<typeof resolveSlackThreadContext>;
  threadTs: string | undefined;
  isThreadReply: boolean;
  messageThreadId: string | undefined;
  allowDirectMessagePlanStream: boolean;
  threadKeys: ReturnType<typeof resolveThreadSessionKeys>;
  sessionKey: string;
  historyKey: string;
};

function resolveSlackBaseConversationId(params: {
  message: SlackMessageEvent;
  isDirectMessage: boolean;
}): string {
  return params.isDirectMessage
    ? `user:${params.message.user ?? "unknown"}`
    : params.message.channel;
}

function normalizeStoredThreadId(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? trimmed : undefined;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return undefined;
}

function resolveCanonicalDirectMessageThreadId(params: {
  cfg: OpenClawConfig;
  agentId: string;
  mainSessionKey: string;
  accountId: string;
  senderId?: string;
}): string | undefined {
  if (!params.senderId) {
    return undefined;
  }
  const store = loadSessionStore(
    resolveStorePath(params.cfg.session?.store, {
      agentId: params.agentId,
    }),
  );
  const resolved = resolveSessionStoreEntry({
    store,
    sessionKey: params.mainSessionKey,
  });
  const entry = resolved.existing;
  if (!entry) {
    return undefined;
  }
  const storedChannel =
    typeof entry.deliveryContext?.channel === "string"
      ? entry.deliveryContext.channel
      : entry.lastChannel;
  const storedTo =
    typeof entry.deliveryContext?.to === "string" ? entry.deliveryContext.to : entry.lastTo;
  const storedAccountId =
    typeof entry.deliveryContext?.accountId === "string"
      ? entry.deliveryContext.accountId
      : entry.lastAccountId;
  const storedThreadId = normalizeStoredThreadId(
    entry.deliveryContext?.threadId ?? entry.lastThreadId,
  );
  if (storedChannel !== "slack") {
    return undefined;
  }
  if (storedTo !== `user:${params.senderId}`) {
    return undefined;
  }
  if (storedAccountId && storedAccountId !== params.accountId) {
    return undefined;
  }
  return storedThreadId;
}

export function resolveSlackRoutingContext(params: {
  ctx: SlackRoutingContextDeps;
  account: ResolvedSlackAccount;
  message: SlackMessageEvent;
  isDirectMessage: boolean;
  isGroupDm: boolean;
  isRoom: boolean;
  isRoomish: boolean;
}): SlackRoutingContext {
  const { ctx, account, message, isDirectMessage, isGroupDm, isRoom, isRoomish } = params;
  let route = resolveAgentRoute({
    cfg: ctx.cfg,
    channel: "slack",
    accountId: account.accountId,
    teamId: ctx.teamId || undefined,
    peer: {
      kind: isDirectMessage ? "direct" : isRoom ? "channel" : "group",
      id: isDirectMessage ? (message.user ?? "unknown") : message.channel,
    },
  });

  const chatType = isDirectMessage ? "direct" : isGroupDm ? "group" : "channel";
  const replyToMode = resolveSlackReplyToMode(account, chatType);
  const threadContext = resolveSlackThreadContext({ message, replyToMode });
  const threadTs = threadContext.incomingThreadTs;
  const isThreadReply = threadContext.isThreadReply;
  const canonicalDmThreadId =
    isDirectMessage && !isThreadReply && replyToMode === "all"
      ? resolveCanonicalDirectMessageThreadId({
          cfg: ctx.cfg,
          agentId: route.agentId,
          mainSessionKey: route.mainSessionKey,
          accountId: account.accountId,
          senderId: message.user,
        })
      : undefined;
  // Keep true thread replies thread-scoped, but preserve channel-level sessions
  // for top-level room turns when replyToMode is off.
  // For DMs, preserve existing auto-thread behavior when replyToMode="all".
  const autoThreadId =
    !isThreadReply && replyToMode === "all"
      ? (canonicalDmThreadId ?? threadContext.messageTs)
      : undefined;
  // Only fork channel/group messages into thread-specific sessions when they are
  // actual thread replies (thread_ts present, different from message ts).
  // Top-level channel messages must stay on the per-channel session for continuity.
  // Before this fix, every channel message used its own ts as threadId, creating
  // isolated sessions per message (regression from #10686).
  const roomThreadId = isThreadReply && threadTs ? threadTs : undefined;
  const canonicalThreadId = isRoomish ? roomThreadId : isThreadReply ? threadTs : autoThreadId;
  const messageThreadId = canonicalThreadId ?? threadContext.messageThreadId;
  const baseConversationId = resolveSlackBaseConversationId({ message, isDirectMessage });
  const boundThreadRoute = canonicalThreadId
    ? resolveRuntimeConversationBindingRoute({
        route,
        conversation: {
          channel: "slack",
          accountId: account.accountId,
          conversationId: canonicalThreadId,
          parentConversationId: baseConversationId,
        },
      })
    : null;
  const runtimeRoute =
    boundThreadRoute?.boundSessionKey || boundThreadRoute?.bindingRecord
      ? boundThreadRoute
      : resolveRuntimeConversationBindingRoute({
          route,
          conversation: {
            channel: "slack",
            accountId: account.accountId,
            conversationId: baseConversationId,
          },
        });
  route = runtimeRoute.route;
  const threadKeys = runtimeRoute.boundSessionKey
    ? { sessionKey: route.sessionKey, parentSessionKey: undefined }
    : resolveThreadSessionKeys({
        baseSessionKey: route.sessionKey,
        threadId: canonicalThreadId,
        parentSessionKey:
          canonicalThreadId && ctx.threadInheritParent ? route.sessionKey : undefined,
      });
  const sessionKey = threadKeys.sessionKey;
  const historyKey =
    isThreadReply && ctx.threadHistoryScope === "thread" ? sessionKey : message.channel;

  return {
    route,
    runtimeBinding: runtimeRoute.bindingRecord,
    chatType,
    replyToMode,
    threadContext,
    threadTs,
    isThreadReply,
    messageThreadId,
    allowDirectMessagePlanStream: Boolean(
      isDirectMessage &&
      !isThreadReply &&
      replyToMode === "all" &&
      canonicalDmThreadId &&
      canonicalDmThreadId !== threadContext.messageTs,
    ),
    threadKeys,
    sessionKey,
    historyKey,
  };
}
