import {
  isAbortRequestText,
  isBtwRequestText,
} from "openclaw/plugin-sdk/command-primitives-runtime";
import type { ClawdbotConfig } from "../runtime-api.js";
import { resolveFeishuAccount } from "./accounts.js";
import { normalizeFeishuCommandProbeBody, resolveFeishuGroupSession } from "./bot-content.js";
import { parseFeishuMessageEvent, type FeishuMessageEvent } from "./bot.js";
import { resolveConfiguredFeishuGroupSessionScope } from "./conversation-id.js";
import { resolveFeishuGroupConfig } from "./policy.js";
import { isFeishuGroupChatType } from "./types.js";

export function getFeishuSequentialKey(params: {
  accountId: string;
  cfg?: ClawdbotConfig;
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
  if (isControlCommandMessage(text)) {
    return `${baseKey}:commands`;
  }
  if (!params.cfg || !isFeishuGroupChatType(event.message.chat_type)) {
    return baseKey;
  }
  const feishuCfg = resolveFeishuAccount({ cfg: params.cfg, accountId }).config;
  const groupConfig = resolveFeishuGroupConfig({ cfg: feishuCfg, groupId: chatId });
  const scope = resolveConfiguredFeishuGroupSessionScope({ groupConfig, feishuCfg });
  if (scope !== "group_topic" && scope !== "group_topic_sender") {
    return baseKey;
  }
  // Native topic hydration happens inside the queued handler. Until then, a root
  // message ID cannot identify the native thread used by later replies.
  if (event.message.chat_type === "topic_group" && !event.message.thread_id?.trim()) {
    return baseKey;
  }
  const parsed = parseFeishuMessageEvent(event, botOpenId);
  const session = resolveFeishuGroupSession({
    chatId,
    senderOpenId: parsed.senderOpenId,
    messageId: parsed.messageId,
    rootId: parsed.rootId,
    threadId: parsed.threadId,
    chatType: parsed.chatType,
    groupConfig,
    feishuCfg,
  });
  return `feishu:${accountId}:${session.peerId}`;
}
