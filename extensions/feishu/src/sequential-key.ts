// Feishu plugin module implements sequential key behavior.
import {
  isAbortRequestText,
  isBtwRequestText,
} from "openclaw/plugin-sdk/command-primitives-runtime";
import type { ClawdbotConfig } from "../runtime-api.js";
import { resolveFeishuAccount } from "./accounts.js";
import { resolveFeishuGroupSession } from "./bot-content.js";
import { parseFeishuMessageEvent, type FeishuMessageEvent } from "./bot.js";
import { resolveFeishuGroupConfig } from "./policy.js";
import { isFeishuGroupChatType } from "./types.js";

export function getFeishuSequentialKey(params: {
  accountId: string;
  event: FeishuMessageEvent;
  cfg?: ClawdbotConfig;
  botOpenId?: string;
  botName?: string;
}): string {
  const { accountId, event, cfg, botOpenId, botName } = params;
  const chatId = event.message.chat_id?.trim() || "unknown";
  const parsed = parseFeishuMessageEvent(event, botOpenId, botName);
  const feishuCfg = cfg ? resolveFeishuAccount({ cfg, accountId }).config : undefined;
  const groupConfig = isFeishuGroupChatType(parsed.chatType)
    ? resolveFeishuGroupConfig({ cfg: feishuCfg, groupId: chatId })
    : undefined;
  const groupSession = isFeishuGroupChatType(parsed.chatType)
    ? resolveFeishuGroupSession({
        chatId,
        senderOpenId: parsed.senderOpenId,
        messageId: parsed.messageId,
        rootId: parsed.rootId,
        threadId: parsed.threadId,
        chatType: parsed.chatType,
        groupConfig,
        feishuCfg,
      })
    : null;
  const baseKey = `feishu:${accountId}:${groupSession?.peerId ?? chatId}`;
  const text = parsed.content.trim();

  if (isAbortRequestText(text)) {
    return `${baseKey}:control`;
  }

  if (isBtwRequestText(text)) {
    return `${baseKey}:btw`;
  }

  return baseKey;
}
