import { isAbortRequestText } from "../../../src/auto-reply/reply/abort.js";
import { isBtwRequestText } from "../../../src/auto-reply/reply/btw-command.js";
import { resolveTelegramForumThreadId } from "./bot/helpers.js";
function getTelegramSequentialKey(ctx) {
  const reaction = ctx.update?.message_reaction;
  if (reaction?.chat?.id) {
    return `telegram:${reaction.chat.id}`;
  }
  const msg = ctx.message ?? ctx.channelPost ?? ctx.editedChannelPost ?? ctx.update?.message ?? ctx.update?.edited_message ?? ctx.update?.channel_post ?? ctx.update?.edited_channel_post ?? ctx.update?.callback_query?.message;
  const chatId = msg?.chat?.id ?? ctx.chat?.id;
  const rawText = msg?.text ?? msg?.caption;
  const botUsername = ctx.me?.username;
  if (isAbortRequestText(rawText, botUsername ? { botUsername } : void 0)) {
    if (typeof chatId === "number") {
      return `telegram:${chatId}:control`;
    }
    return "telegram:control";
  }
  if (isBtwRequestText(rawText, botUsername ? { botUsername } : void 0)) {
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
  const threadId = isGroup ? resolveTelegramForumThreadId({ isForum, messageThreadId }) : messageThreadId;
  if (typeof chatId === "number") {
    return threadId != null ? `telegram:${chatId}:topic:${threadId}` : `telegram:${chatId}`;
  }
  return "telegram:unknown";
}
export {
  getTelegramSequentialKey
};
