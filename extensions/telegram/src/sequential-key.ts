import { type Message, type UserFromGetMe } from "@grammyjs/types";
import { isEmbeddedRunStreamingForSessionKey } from "../../../src/agents/pi-embedded.js";
import { isAbortRequestText } from "../../../src/auto-reply/reply/abort.js";
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

export function getTelegramSequentialKey(ctx: TelegramSequentialKeyContext): string {
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
  const isGroup = msg?.chat?.type === "group" || msg?.chat?.type === "supergroup";
  const messageThreadId = msg?.message_thread_id;
  const isForum = msg?.chat?.is_forum;
  const threadId = isGroup
    ? resolveTelegramForumThreadId({ isForum, messageThreadId })
    : messageThreadId;
  if (typeof chatId === "number") {
    const baseKey =
      threadId != null ? `telegram:${chatId}:topic:${threadId}` : `telegram:${chatId}`;
    // If a run is actively streaming for this conversation, use a separate
    // sequential key so this message isn't blocked behind the active handler.
    // This allows steer injection to arrive mid-turn instead of queuing.
    const conversationKey = threadId != null ? `${chatId}:topic:${threadId}` : String(chatId);
    if (isEmbeddedRunStreamingForSessionKey(conversationKey)) {
      return `${baseKey}:steer`;
    }
    return baseKey;
  }
  return "telegram:unknown";
}
