import type { ReplyToMode } from "openclaw/plugin-sdk/config-runtime";
import type { SlackAppMentionEvent, SlackMessageEvent } from "./types.js";

export type SlackThreadContext = {
  incomingThreadTs?: string;
  messageTs?: string;
  isThreadReply: boolean;
  replyToId?: string;
  messageThreadId?: string;
};

export function resolveSlackThreadContext(params: {
  message: SlackMessageEvent | SlackAppMentionEvent;
  replyToMode: ReplyToMode;
}): SlackThreadContext {
  const incomingThreadTs = params.message.thread_ts;
  const eventTs = params.message.event_ts;
  const messageTs = params.message.ts ?? eventTs;
  const hasThreadTs = typeof incomingThreadTs === "string" && incomingThreadTs.length > 0;
  const isThreadReply =
    hasThreadTs && (incomingThreadTs !== messageTs || Boolean(params.message.parent_user_id));
  const replyToId = incomingThreadTs ?? messageTs;
  // Preserve thread context for thread replies AND for thread-root messages
  // (e.g. Slack Agents & Assistants DMs where thread_ts == ts on the initial
  // message). Without this, tool calls that run during the same turn (subagent
  // results) lose the thread identifier after the first reply because
  // hasRepliedRef gets marked true, causing subsequent sendMessage calls to fall
  // through to the top-level channel.
  const messageThreadId = isThreadReply
    ? incomingThreadTs
    : hasThreadTs
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

/**
 * Resolves Slack thread targeting for replies and status indicators.
 *
 * @returns replyThreadTs - Thread timestamp for reply messages
 * @returns statusThreadTs - Thread timestamp for status indicators (typing, etc.)
 * @returns isThreadReply - true if this is a genuine user reply in a thread,
 *                          false if thread_ts comes from a bot status message (e.g. typing indicator)
 */
export function resolveSlackThreadTargets(params: {
  message: SlackMessageEvent | SlackAppMentionEvent;
  replyToMode: ReplyToMode;
}) {
  const ctx = resolveSlackThreadContext(params);
  const { incomingThreadTs, messageTs, isThreadReply } = ctx;
  const replyThreadTs = isThreadReply
    ? incomingThreadTs
    : params.replyToMode === "all"
      ? messageTs
      : undefined;
  const statusThreadTs = replyThreadTs;
  return { replyThreadTs, statusThreadTs, isThreadReply };
}
