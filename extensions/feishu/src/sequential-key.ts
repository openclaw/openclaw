import {
  isAbortRequestText,
  isBtwRequestText,
} from "openclaw/plugin-sdk/command-primitives-runtime";
import type { ClawdbotConfig, RuntimeEnv } from "../runtime-api.js";
import { resolveFeishuRuntimeAccount } from "./accounts.js";
import { resolveFeishuGroupSession } from "./bot-content.js";
import {
  isFeishuTopicSessionScope,
  parseFeishuMessageEvent,
  resolveConfiguredFeishuGroupSessionScope,
  type FeishuMessageEvent,
} from "./bot.js";
import { resolveFeishuGroupConfig } from "./policy.js";
import { getMessageFeishu } from "./send.js";
import { isFeishuGroupChatType } from "./types.js";

export async function getFeishuSequentialKey(params: {
  cfg: ClawdbotConfig;
  accountId: string;
  event: FeishuMessageEvent;
  botOpenId?: string;
  botName?: string;
  runtime?: RuntimeEnv;
  fetchMessage?: typeof getMessageFeishu;
}): Promise<string> {
  const {
    cfg,
    accountId,
    event,
    botOpenId,
    botName,
    runtime,
    fetchMessage = getMessageFeishu,
  } = params;
  const parsed = parseFeishuMessageEvent(event, botOpenId, botName);
  const baseKey = await resolveFeishuSequentialBaseKey({
    accountId,
    cfg,
    fetchMessage,
    parsed,
    runtime,
  });
  const text = parsed.content.trim();

  if (isAbortRequestText(text)) {
    return `${baseKey}:control`;
  }

  if (isBtwRequestText(text)) {
    return `${baseKey}:btw`;
  }

  return baseKey;
}

async function resolveFeishuSequentialBaseKey(params: {
  accountId: string;
  cfg: ClawdbotConfig;
  fetchMessage: typeof getMessageFeishu;
  parsed: ReturnType<typeof parseFeishuMessageEvent>;
  runtime?: RuntimeEnv;
}): Promise<string> {
  const { accountId, cfg, fetchMessage, parsed, runtime } = params;
  const chatId = parsed.chatId?.trim() || "unknown";
  if (!isFeishuGroupChatType(parsed.chatType)) {
    return `feishu:${accountId}:${chatId}`;
  }

  try {
    const account = resolveFeishuRuntimeAccount({ cfg, accountId });
    const feishuCfg = account.config;
    const groupConfig = resolveFeishuGroupConfig({ cfg: feishuCfg, groupId: chatId });
    const groupSessionScope = resolveConfiguredFeishuGroupSessionScope({ groupConfig, feishuCfg });
    let effectiveThreadId = parsed.threadId;
    if (
      parsed.chatType === "topic_group" &&
      !effectiveThreadId &&
      isFeishuTopicSessionScope(groupSessionScope)
    ) {
      try {
        effectiveThreadId =
          (
            await fetchMessage({
              cfg,
              accountId: account.accountId,
              messageId: parsed.messageId,
            })
          )?.threadId?.trim() || undefined;
      } catch (err) {
        (runtime?.log ?? console.log)(
          `feishu[${account.accountId}]: failed to hydrate topic thread_id for sequential key message=${parsed.messageId}: ${String(err)}`,
        );
      }
    }
    const groupSession = resolveFeishuGroupSession({
      chatId,
      senderOpenId: parsed.senderOpenId,
      messageId: parsed.messageId,
      rootId: parsed.rootId,
      threadId: effectiveThreadId,
      chatType: parsed.chatType,
      groupConfig,
      feishuCfg,
    });
    return `feishu:${accountId}:${groupSession.peerId || chatId}`;
  } catch (err) {
    (runtime?.log ?? console.log)(
      `feishu[${accountId}]: failed to resolve scoped sequential key for chat=${chatId}: ${String(err)}`,
    );
    return `feishu:${accountId}:${chatId}`;
  }
}
