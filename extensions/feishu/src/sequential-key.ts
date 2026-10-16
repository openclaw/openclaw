import {
  isAbortRequestText,
  isBtwRequestText,
} from "openclaw/plugin-sdk/command-primitives-runtime";
import { parseFeishuMessageEvent, type FeishuMessageEvent } from "./bot.js";

export function getFeishuSequentialKey(params: {
  accountId: string;
  event: FeishuMessageEvent;
  preparedContent?: string;
  botOpenId?: string;
}): string {
  const { accountId, event, botOpenId, preparedContent } = params;
  const chatId = event.message.chat_id?.trim() || "unknown";
  const rootId = event.message.root_id?.trim();
  const threadId = event.message.thread_id?.trim();
  const topicId =
    event.message.chat_type === "topic_group"
      ? threadId || rootId || event.message.message_id?.trim()
      : undefined;
  const baseKey = topicId
    ? `feishu:${accountId}:${chatId}:topic:${topicId}`
    : `feishu:${accountId}:${chatId}`;
  const text = (preparedContent ?? parseFeishuMessageEvent(event, botOpenId).content).trim();

  if (isAbortRequestText(text)) {
    return `${baseKey}:control`;
  }

  if (isBtwRequestText(text)) {
    return `${baseKey}:btw`;
  }

  return baseKey;
}
