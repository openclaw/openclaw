// Feishu plugin module implements sequential key behavior.
import {
  isAbortRequestText,
  isBtwRequestText,
} from "openclaw/plugin-sdk/command-primitives-runtime";
import { normalizeFeishuCommandProbeBody } from "./bot-content.js";
import { parseFeishuMessageEvent, type FeishuMessageEvent } from "./bot.js";

export function getFeishuSequentialKey(params: {
  accountId: string;
  event: FeishuMessageEvent;
  botOpenId?: string;
  botName?: string;
}): string {
  const { accountId, event, botOpenId, botName } = params;
  const chatId = event.message.chat_id?.trim() || "unknown";
  const baseKey = `feishu:${accountId}:${chatId}`;
  const parsed = parseFeishuMessageEvent(event, botOpenId, botName);
  // Keep self-mention context in content for the model, but strip <at>
  // tags for sequential-key resolution — see #72504.
  const text = normalizeFeishuCommandProbeBody(parsed.content).trim();

  if (isAbortRequestText(text)) {
    return `${baseKey}:control`;
  }

  if (isBtwRequestText(text)) {
    return `${baseKey}:btw`;
  }

  return baseKey;
}
