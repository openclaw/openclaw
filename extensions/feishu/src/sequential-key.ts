import { isAbortRequestText, isBtwRequestText } from "openclaw/plugin-sdk/reply-runtime";
import type { GroupSessionScope } from "./bot-content.js";
import { parseFeishuMessageEvent, type FeishuMessageEvent } from "./bot.js";

export function getFeishuSequentialKey(params: {
  accountId: string;
  event: FeishuMessageEvent;
  botOpenId?: string;
  botName?: string;
  groupSessionScope?: GroupSessionScope;
}): string {
  const { accountId, event, botOpenId, botName, groupSessionScope } = params;
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

  // Per-topic lanes only apply to group chats that are explicitly
  // configured for topic-scoped sessions.
  //
  // 1. `chat_type !== "group"` (DMs: `p2p` / `private`) deliberately stay
  //    on a single chat-wide lane even when `groupSessionScope` is
  //    globally set to `group_topic` / `group_topic_sender` via a wildcard
  //    entry, because Feishu DMs can carry `root_id` for quote replies
  //    and must preserve per-chat FIFO — see the
  //    "propagates parent/root message ids into inbound context for
  //    reply reconstruction" DM fixture in bot.test.ts.
  //
  // 2. Normal (`group` / `group_sender`) groups also stay on a single
  //    chat-wide lane even when a quote reply carries `root_id`, because
  //    those groups share one session store and must preserve per-chat
  //    FIFO — see the "replies to triggering message in normal group
  //    even when root_id is present (#32980)" assertion in bot.test.ts
  //    and the `topicScope` gate in resolveFeishuGroupSession.
  const isGroupChat = event.message.chat_type === "group";
  if (
    isGroupChat &&
    (groupSessionScope === "group_topic" || groupSessionScope === "group_topic_sender")
  ) {
    const topicLaneId = resolveFeishuTopicLaneId(event);
    if (topicLaneId) {
      return `${baseKey}:topic:${topicLaneId}`;
    }
  }

  return baseKey;
}

function resolveFeishuTopicLaneId(event: FeishuMessageEvent): string | undefined {
  // Align with the root_id-over-thread_id precedence used by
  // resolveFeishuGroupSession in bot-content.ts and anchored by the
  // bot.test.ts "keeps root_id as topic key when root_id and thread_id
  // both exist" assertion.
  return event.message.root_id?.trim() || event.message.thread_id?.trim() || undefined;
}
