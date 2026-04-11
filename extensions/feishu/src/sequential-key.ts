import { isAbortRequestText, isBtwRequestText } from "openclaw/plugin-sdk/reply-runtime";
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
  const text = parsed.content.trim();

  // Control and out-of-band lanes stay chat-wide so /stop and /btw never
  // get blocked behind a busy topic queue — this mirrors the escape-hatch
  // behavior already used by extensions/telegram/src/sequential-key.ts.
  if (isAbortRequestText(text)) {
    return `${baseKey}:control`;
  }

  if (isBtwRequestText(text)) {
    return `${baseKey}:btw`;
  }

  // Topic-group messages carry root_id (or thread_id) and should run on
  // their own per-topic lane so different topics in the same chat can be
  // processed concurrently instead of waiting for each other. Precedence
  // follows the root_id-over-thread_id convention already used by
  // resolveFeishuGroupSession in bot-content.ts and anchored by the
  // bot.test.ts "keeps root_id as topic key when root_id and thread_id
  // both exist" assertion.
  const topicLaneId = resolveFeishuTopicLaneId(event);
  if (topicLaneId) {
    return `${baseKey}:topic:${topicLaneId}`;
  }

  return baseKey;
}

function resolveFeishuTopicLaneId(event: FeishuMessageEvent): string | undefined {
  return event.message.root_id?.trim() || event.message.thread_id?.trim() || undefined;
}
