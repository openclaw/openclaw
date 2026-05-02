import {
  isAbortRequestText,
  isBtwRequestText,
} from "openclaw/plugin-sdk/command-primitives-runtime";
import { resolveFeishuGroupSession } from "./bot-content.js";
import { parseFeishuMessageEvent, type FeishuMessageEvent } from "./bot.js";
import { resolveFeishuGroupConfig } from "./policy.js";
import { isFeishuGroupChatType, type FeishuConfig } from "./types.js";

export function getFeishuSequentialKey(params: {
  accountId: string;
  event: FeishuMessageEvent;
  botOpenId?: string;
  botName?: string;
  feishuCfg?: FeishuConfig;
}): string {
  const { accountId, event, botOpenId, botName, feishuCfg } = params;
  const chatId = event.message.chat_id?.trim() || "unknown";
  const baseKey = `feishu:${accountId}:${chatId}`;
  const parsed = parseFeishuMessageEvent(event, botOpenId, botName);
  const text = parsed.content.trim();

  if (isAbortRequestText(text)) {
    return `${baseKey}:control`;
  }

  if (isBtwRequestText(text)) {
    return `${baseKey}:btw`;
  }

  if (isFeishuGroupChatType(event.message.chat_type)) {
    const senderOpenId =
      event.sender.sender_id.open_id?.trim() || event.sender.sender_id.user_id?.trim() || "unknown";
    const groupSession = resolveFeishuGroupSession({
      chatId,
      senderOpenId,
      messageId: event.message.message_id,
      rootId: event.message.root_id,
      threadId: event.message.thread_id,
      chatType: event.message.chat_type,
      groupConfig: resolveFeishuGroupConfig({ cfg: feishuCfg, groupId: chatId }),
      feishuCfg,
    });

    return `feishu:${accountId}:${groupSession.peerId}`;
  }

  return baseKey;
}
