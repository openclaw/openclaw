import type { Message, UserFromGetMe } from "@grammyjs/types";
import {
  listChatCommands,
  maybeResolveTextAlias,
  normalizeCommandBody,
} from "openclaw/plugin-sdk/command-auth";
import { parseExecApprovalCommandText } from "openclaw/plugin-sdk/infra-runtime";
import { isAbortRequestText } from "openclaw/plugin-sdk/reply-runtime";
import { isBtwRequestText } from "openclaw/plugin-sdk/reply-runtime";
import { resolveTelegramForumThreadId } from "./bot/helpers.js";

export type TelegramSequentialKeyContext = {
  chat?: { id?: number };
  me?: UserFromGetMe;
  message?: Message;
  channelPost?: Message;
  editedChannelPost?: Message;
  update?: {
    message?: Message;
    edited_message?: Message;
    channel_post?: Message;
    edited_channel_post?: Message;
    callback_query?: { message?: Message; data?: string };
    message_reaction?: { chat?: { id?: number } };
  };
};

export type TelegramSequentialKeyOptions = {
  /**
   * When provided, the sequentializer checks whether an embedded Pi run is
   * active for the resolved chat/thread.  If a run is active, the key is
   * scoped to the individual message so it can be dispatched in parallel
   * (needed for steer / interrupt queue modes).
   */
  isRunActiveForChat?: (chatId: number, threadId: number | undefined, senderId: string) => boolean;
};

/**
 * Maximum entries in the chatSessionCache before FIFO eviction kicks in.
 */
export const CHAT_SESSION_CACHE_MAX = 500;

/**
 * Build the cache key used by chatSessionCache.
 * For groups: keyed by conversation (chatId + threadId) — the session is shared.
 * For DMs: includes senderId because DM bridge/business-chat deliveries can
 * route different senders sharing the same chatId to different sessions.
 */
export function buildChatSessionCacheKey(
  chatId: number | string,
  threadId: number | undefined,
  senderId?: string,
): string {
  const base = threadId != null ? `${chatId}:${threadId}` : String(chatId);
  return senderId ? `${base}:${senderId}` : base;
}

function resolveStatusCommandControlLane(params: {
  rawText?: string;
  botUsername?: string;
}): boolean {
  // Only read-only status commands should bypass the per-topic lane. Commands
  // like /export-session stay on the normal lane because they materialize
  // session state to disk and should not interleave with an active turn.
  const normalizedBody = normalizeCommandBody(
    params.rawText?.trim() ?? "",
    params.botUsername ? { botUsername: params.botUsername } : undefined,
  );
  const alias = maybeResolveTextAlias(normalizedBody);
  if (!alias) {
    return false;
  }
  const command = listChatCommands().find((entry) =>
    entry.textAliases.some((candidate) => candidate.trim().toLowerCase() === alias),
  );
  return command?.category === "status" && command.key !== "export-session";
}

export function getTelegramSequentialKey(
  ctx: TelegramSequentialKeyContext,
  options?: TelegramSequentialKeyOptions,
): string {
  const reaction = ctx.update?.message_reaction;
  if (reaction?.chat?.id) {
    return `telegram:${reaction.chat.id}`;
  }
  const msg =
    ctx.message ??
    ctx.channelPost ??
    ctx.editedChannelPost ??
    ctx.update?.message ??
    ctx.update?.edited_message ??
    ctx.update?.channel_post ??
    ctx.update?.edited_channel_post ??
    ctx.update?.callback_query?.message;
  const chatId = msg?.chat?.id ?? ctx.chat?.id;
  const rawText = msg?.text ?? msg?.caption;
  const botUsername = ctx.me?.username;
  if (isAbortRequestText(rawText, botUsername ? { botUsername } : undefined)) {
    if (typeof chatId === "number") {
      return `telegram:${chatId}:control`;
    }
    return "telegram:control";
  }
  if (resolveStatusCommandControlLane({ rawText, botUsername })) {
    if (typeof chatId === "number") {
      return `telegram:${chatId}:control`;
    }
    return "telegram:control";
  }
  if (isBtwRequestText(rawText, botUsername ? { botUsername } : undefined)) {
    const messageId = msg?.message_id;
    if (typeof chatId === "number" && typeof messageId === "number") {
      return `telegram:${chatId}:btw:${messageId}`;
    }
    if (typeof chatId === "number") {
      return `telegram:${chatId}:btw`;
    }
    return "telegram:btw";
  }
  const callbackData = ctx.update?.callback_query?.data;
  if (callbackData && parseExecApprovalCommandText(callbackData) !== null) {
    if (typeof chatId === "number") {
      return `telegram:${chatId}:approval`;
    }
    return "telegram:approval";
  }
  const isGroup = msg?.chat?.type === "group" || msg?.chat?.type === "supergroup";
  const messageThreadId = msg?.message_thread_id;
  const isForum = msg?.chat?.is_forum;
  const threadId = isGroup
    ? resolveTelegramForumThreadId({ isForum, messageThreadId })
    : messageThreadId;

  if (typeof chatId === "number") {
    // When a run is active and the queue mode needs immediate delivery,
    // use a per-message key so grammY dispatches this update in parallel
    // rather than serializing it behind the active handler.
    if (options?.isRunActiveForChat) {
      const senderId = msg?.from?.id ? String(msg.from.id) : "";
      if (options.isRunActiveForChat(chatId, threadId, senderId)) {
        const messageId = msg?.message_id;
        if (typeof messageId === "number") {
          const base =
            threadId != null ? `telegram:${chatId}:topic:${threadId}` : `telegram:${chatId}`;
          return `${base}:msg:${messageId}`;
        }
      }
    }
    return threadId != null ? `telegram:${chatId}:topic:${threadId}` : `telegram:${chatId}`;
  }
  return "telegram:unknown";
}
