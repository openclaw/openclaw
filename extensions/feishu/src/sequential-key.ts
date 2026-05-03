import {
  isAbortRequestText,
  isBtwRequestText,
} from "openclaw/plugin-sdk/command-primitives-runtime";
import { parseFeishuMessageEvent, type FeishuMessageEvent } from "./bot.js";

export function getFeishuSequentialKey(params: {
  accountId: string;
  event: FeishuMessageEvent;
  botOpenId?: string;
  botName?: string;
}): string {
  const { accountId, event, botOpenId, botName } = params;
  const chatId = event.message.chat_id?.trim() || "unknown";

  // DM topic parallelism: messages inside a DM thread get their own queue
  // key, enabling parallel processing of independent DM topics.
  // Group topic parallelism is handled by the existing per-peer-id queue logic.
  const isGroup = event.message.chat_type === "group";
  let baseKey: string;
  if (!isGroup) {
    const topicId = event.message.root_id?.trim() || event.message.thread_id?.trim();
    baseKey = topicId
      ? `feishu:${accountId}:${chatId}:topic:${topicId}`
      : `feishu:${accountId}:${chatId}`;
  } else {
    baseKey = `feishu:${accountId}:${chatId}`;
  }

  const parsed = parseFeishuMessageEvent(event, botOpenId, botName);
  const text = parsed.content.trim();

  if (isAbortRequestText(text)) {
    return `${baseKey}:control`;
  }

  if (isBtwRequestText(text)) {
    return `${baseKey}:btw`;
  }

  return baseKey;
}
