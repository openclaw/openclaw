import {
  isAbortRequestText,
  isBtwRequestText,
} from "openclaw/plugin-sdk/command-primitives-runtime";
import { normalizeFeishuCommandProbeBody } from "./bot-content.js";
import { parseFeishuMessageEvent, type FeishuMessageEvent } from "./bot.js";

export function getFeishuSequentialKey(params: {
  accountId: string;
  event: FeishuMessageEvent;
  preparedContent?: string;
  botOpenId?: string;
  isControlCommandMessage: (text: string) => boolean;
}): string {
  const { accountId, event, botOpenId, preparedContent, isControlCommandMessage } = params;
  const chatId = event.message.chat_id?.trim() || "unknown";
  const baseKey = `feishu:${accountId}:${chatId}`;
  const text = normalizeFeishuCommandProbeBody(
    preparedContent ?? parseFeishuMessageEvent(event, botOpenId).content,
  );

  if (isAbortRequestText(text)) {
    return `${baseKey}:control`;
  }

  if (isBtwRequestText(text)) {
    return `${baseKey}:btw`;
  }

  // Commands that may run inference must not hold the abort lane.
  return isControlCommandMessage(text) ? `${baseKey}:commands` : baseKey;
}
