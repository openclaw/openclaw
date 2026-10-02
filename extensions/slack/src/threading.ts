import type { ReplyToMode } from "openclaw/plugin-sdk/config-contracts";
import type { SlackAppMentionEvent, SlackMessageEvent } from "./types.js";

type SlackThreadContext = {
  incomingThreadTs?: string;
  messageTs?: string;
  isThreadReply: boolean;
  replyToId?: string;
  messageThreadId?: string;
};

export function resolveSlackThreadContext(params: {
  message: SlackMessageEvent | SlackAppMentionEvent;
  replyToMode: ReplyToMode;
  isDirectMessage?: boolean;
}): SlackThreadContext {
  const incomingThreadTs = params.message.thread_ts;
  const eventTs = params.message.event_ts;
  const messageTs = params.message.ts ?? eventTs;
  const hasThreadTs = typeof incomingThreadTs === "string" && incomingThreadTs.length > 0;
  const isThreadReply =
    hasThreadTs && (incomingThreadTs !== messageTs || Boolean(params.message.parent_user_id));
  // ReplyToId names a genuine parent only. Standalone tool anchoring uses
  // CurrentMessageId; restart-safe roots persist through the routed thread id.
  const replyToId = isThreadReply ? incomingThreadTs : undefined;
  // Preserve thread context for Slack Agents & Assistants DM root messages
  // where thread_ts == ts. Non-DM self-thread roots must stay unset because
  // downstream tool threading treats MessageThreadId as an explicit thread
  // target and overrides replyToMode to "all".
  const isAssistantDmThreadRoot = hasThreadTs && !isThreadReply && params.isDirectMessage === true;
  const messageThreadId =
    isThreadReply || isAssistantDmThreadRoot
      ? incomingThreadTs
      : params.replyToMode === "all"
        ? messageTs
        : undefined;
  return {
    incomingThreadTs,
    messageTs,
    isThreadReply,
    replyToId,
    messageThreadId,
  };
}
