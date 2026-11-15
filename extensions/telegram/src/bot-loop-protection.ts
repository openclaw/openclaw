// Telegram plugin module maps bot-authored inbound turns onto the shared bot-pair loop guard.
import type { Message } from "grammy/types";
import type { ChannelBotLoopProtectionFacts } from "openclaw/plugin-sdk/channel-inbound";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";

/**
 * Whether a bot wrote this message as itself. The Bot API marks a message sent on behalf of
 * a chat with `sender_chat`; in a group its `from` is then a backward-compatibility
 * placeholder, and a channel post may have no `from` at all, in which case the channel_post
 * pipeline stamps the channel itself. Neither names the author, so anonymous admins,
 * linked-channel forwards and unattributed channel posts never count, and two bots that
 * only post as a channel are not bounded here. A channel post that does carry a bot `from`
 * still counts.
 */
function isOtherBotAuthor(msg: Message, botUserId: number): boolean {
  const sender = msg.from;
  if (sender?.is_bot !== true || sender.id === botUserId) {
    return false;
  }
  const senderChat = msg.sender_chat;
  if (sender.id === senderChat?.id || (msg.chat.type !== "private" && sender.id === msg.chat.id)) {
    return false;
  }
  return !senderChat || (senderChat.type === "channel" && senderChat.id === msg.chat.id);
}

/**
 * Bot-pair facts for the core turn runner, or undefined when this turn is not another
 * bot's message. Core records the pair and drops the turn before session record and
 * dispatch once the pair exceeds its budget; Telegram only identifies the two bots.
 *
 * Telegram declares no channel or account override, so only
 * `channels.defaults.botLoopProtection` applies, as for Feishu.
 */
export function resolveTelegramBotLoopProtection(params: {
  cfg: OpenClawConfig;
  accountId: string;
  msg: Message;
  botUserId: number | undefined;
}): ChannelBotLoopProtectionFacts | undefined {
  const sender = params.msg.from;
  if (!sender || params.botUserId == null || !isOtherBotAuthor(params.msg, params.botUserId)) {
    return undefined;
  }
  return {
    scopeId: params.accountId,
    conversationId: String(params.msg.chat.id),
    senderId: String(sender.id),
    receiverId: String(params.botUserId),
    // A spooled replay of the same update must not spend the pair budget twice.
    eventId: String(params.msg.message_id),
    defaultsConfig: params.cfg.channels?.defaults?.botLoopProtection,
    defaultEnabled: true,
    nowMs: params.msg.date * 1000,
  };
}
