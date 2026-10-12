import {
  isAbortRequestText,
  isBtwRequestText,
} from "openclaw/plugin-sdk/command-primitives-runtime";
import type { ClawdbotConfig } from "../runtime-api.js";
import { resolveFeishuAccount } from "./accounts.js";
import { resolveFeishuGroupSession } from "./bot-content.js";
import { parseFeishuMessageEvent, type FeishuMessageEvent } from "./bot.js";
import { resolveFeishuGroupConfig } from "./policy.js";

export function getFeishuSequentialKey(params: {
  cfg?: ClawdbotConfig;
  accountId: string;
  event: FeishuMessageEvent;
  preparedContent?: string;
  botOpenId?: string;
}): string {
  const { accountId, event, botOpenId, preparedContent } = params;
  const chatId = event.message.chat_id?.trim() || "unknown";
  const parsed = parseFeishuMessageEvent(event, botOpenId);
  const feishuCfg = params.cfg
    ? resolveFeishuAccount({ cfg: params.cfg, accountId }).config
    : undefined;
  // Use the same scope and native-topic identity as session routing. Threads
  // configured to share a group session must still share preparation ordering.
  const peerId =
    parsed.chatType === "group" || parsed.chatType === "topic_group"
      ? resolveFeishuGroupSession({
          chatId,
          senderOpenId: parsed.senderOpenId,
          messageId: parsed.messageId,
          rootId: parsed.rootId,
          threadId: parsed.threadId,
          chatType: parsed.chatType,
          groupConfig: resolveFeishuGroupConfig({ cfg: feishuCfg, groupId: chatId }),
          feishuCfg,
        }).peerId
      : chatId;
  const baseKey = `feishu:${accountId}:${peerId}`;
  const text = (preparedContent ?? parsed.content).trim();

  if (isAbortRequestText(text)) {
    return `${baseKey}:control`;
  }

  if (isBtwRequestText(text)) {
    return `${baseKey}:btw`;
  }

  return baseKey;
}
