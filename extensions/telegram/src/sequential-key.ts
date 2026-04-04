import { type Message, type UserFromGetMe } from "@grammyjs/types";
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
    callback_query?: { message?: Message };
    message_reaction?: { chat?: { id?: number } };
  };
};

export type TelegramSequentialKeyOptions = {
  isRunActiveForChat?: (chatId: number, threadId?: number) => boolean;
};

export function getTelegramSequentialKey(
  ctx: TelegramSequentialKeyContext,
  opts?: TelegramSequentialKeyOptions,
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
  const isGroup = msg?.chat?.type === "group" || msg?.chat?.type === "supergroup";
  const messageThreadId = msg?.message_thread_id;
  const isForum = msg?.chat?.is_forum;
  const threadId = isGroup
    ? resolveTelegramForumThreadId({ isForum, messageThreadId })
    : messageThreadId;
  // Use per-message keys only when a run is already active for this chat so
  // that steer-mode messages are not blocked behind the in-progress run.
  // When no run is active, fall back to per-chat keys to preserve FIFO
  // ordering.  Run-level serialization is handled by the session lane queue
  // (enqueueCommandInLane, maxConcurrent=1).
  const messageId = msg?.message_id;
  const runActive = typeof chatId === "number" && opts?.isRunActiveForChat?.(chatId, threadId ?? undefined);
  if (typeof chatId === "number") {
    const base = threadId != null ? `telegram:${chatId}:topic:${threadId}` : `telegram:${chatId}`;
    return runActive && typeof messageId === "number" ? `${base}:${messageId}` : base;
  }
  return "telegram:unknown";
}
