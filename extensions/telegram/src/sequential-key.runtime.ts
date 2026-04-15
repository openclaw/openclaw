import { hasControlCommand } from "openclaw/plugin-sdk/command-detection";
import {
  resolveSessionStoreEntry,
  type OpenClawConfig,
  type TelegramGroupConfig,
  type TelegramTopicConfig,
} from "openclaw/plugin-sdk/config-runtime";
import type { loadSessionStore as loadSessionStoreRuntime } from "openclaw/plugin-sdk/config-runtime";
import type { resolveStorePath as resolveStorePathRuntime } from "openclaw/plugin-sdk/config-runtime";
import { resolveThreadSessionKeys } from "openclaw/plugin-sdk/routing";
import { normalizeOptionalLowercaseString } from "openclaw/plugin-sdk/text-runtime";
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
  loadSessionStore: typeof loadSessionStoreRuntime;
  resolveTelegramGroupConfig: ResolveTelegramGroupConfig;
  resolveStorePath: typeof resolveStorePathRuntime;
};

type QueueMode = "collect" | "followup" | "interrupt" | "steer" | "steer-backlog";

function normalizeQueueMode(value: unknown): QueueMode | undefined {
  const normalized = normalizeOptionalLowercaseString(
    typeof value === "string" ? value : undefined,
  );
  if (!normalized) {
    return undefined;
  }
  if (normalized === "queue" || normalized === "queued" || normalized === "steering") {
    return "steer";
  }
  if (normalized === "interrupts" || normalized === "abort") {
    return "interrupt";
  }
  if (
    normalized === "steer+backlog" ||
    normalized === "steer-backlog" ||
    normalized === "steer_backlog"
  ) {
    return "steer-backlog";
  }
  if (
    normalized === "collect" ||
    normalized === "followup" ||
    normalized === "interrupt" ||
    normalized === "steer"
  ) {
    return normalized;
  }
  return undefined;
}

function resolveQueueModeForSession(params: {
  cfg: OpenClawConfig;
  agentId: string;
  loadSessionStore: typeof loadSessionStoreRuntime;
  resolveStorePath: typeof resolveStorePathRuntime;
  sessionKey: string;
}): QueueMode {
  const storePath = params.resolveStorePath(params.cfg.session?.store, {
    agentId: params.agentId,
  });
  const store = params.loadSessionStore(storePath);
  const sessionEntry = resolveSessionStoreEntry({
    store,
    sessionKey: params.sessionKey,
  }).existing;
  const providerModeRaw =
    params.cfg.messages?.queue?.byChannel && typeof params.cfg.messages.queue.byChannel === "object"
      ? params.cfg.messages.queue.byChannel.telegram
      : undefined;
  return (
    normalizeQueueMode(sessionEntry?.queueMode) ??
    normalizeQueueMode(providerModeRaw) ??
    normalizeQueueMode(params.cfg.messages?.queue?.mode) ??
    "collect"
  );
}

function resolvesImmediateQueueMode(mode: QueueMode): boolean {
  return mode === "interrupt" || mode === "steer" || mode === "steer-backlog";
}

function resolveBusySessionControlLane(
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
  if (!msg) {
    return undefined;
  }
  const chatId = msg.chat?.id ?? ctx.chat?.id;
  if (typeof chatId !== "number") {
    return undefined;
  }
  if (msg.chat?.type === "channel") {
    return undefined;
  }
  const rawText = msg.text ?? msg.caption;
  if (!rawText?.trim()) {
    return undefined;
  }
  const cfg = params.loadRuntimeConfig();
  if (
    hasControlCommand(rawText, cfg, ctx.me?.username ? { botUsername: ctx.me.username } : undefined)
  ) {
    return undefined;
  }
  const isGroup = msg.chat?.type === "group" || msg.chat?.type === "supergroup";
  const resolvedThreadId = isGroup
    ? resolveTelegramForumThreadId({
        isForum: msg.chat?.is_forum,
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
  if (!isReplyRunActiveForSessionKey(sessionKey)) {
    return undefined;
  }
  const queueMode = resolveQueueModeForSession({
    cfg,
    agentId: route.agentId,
    loadSessionStore: params.loadSessionStore,
    resolveStorePath: params.resolveStorePath,
    sessionKey,
  });
  if (!resolvesImmediateQueueMode(queueMode)) {
    return undefined;
  }
  // Preserve ordinary per-topic sequencing unless a session is already busy
  // and the queue policy expects a prompt control-style handoff.
  return `telegram:session-control:${sessionKey}`;
}

export function createTelegramSequentialKey(params: CreateTelegramSequentialKeyParams) {
  return (ctx: TelegramSequentialKeyContext): string => {
    const baseKey = getTelegramSequentialKey(ctx);
    if (baseKey.endsWith(":control") || baseKey.includes(":btw:") || baseKey.endsWith(":btw")) {
      return baseKey;
    }
    if (baseKey.endsWith(":approval")) {
      return baseKey;
    }
    return resolveBusySessionControlLane(ctx, params) ?? baseKey;
  };
}
