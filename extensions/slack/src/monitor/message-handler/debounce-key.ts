import type { SlackMessageEvent } from "../../types.js";

function resolveSlackSenderId(message: SlackMessageEvent): string | null {
  return message.user ?? message.bot_id ?? null;
}

export function buildTopLevelSlackConversationKey(
  message: SlackMessageEvent,
  accountId: string,
  teamId?: string,
): string | null {
  if (message.thread_ts || message.parent_user_id) {
    return null;
  }
  const senderId = resolveSlackSenderId(message);
  if (!senderId) {
    return null;
  }
  return `slack:${accountId}:${teamId ? `${teamId}:` : ""}${message.channel}:${senderId}`;
}

export function buildSlackDebounceKey(
  message: SlackMessageEvent,
  accountId: string,
  teamId?: string,
): string | null {
  const senderId = resolveSlackSenderId(message);
  if (!senderId) {
    return null;
  }
  const messageTs = message.ts ?? message.event_ts;
  const threadKey = message.thread_ts
    ? `${message.channel}:${message.thread_ts}`
    : message.parent_user_id && messageTs
      ? `${message.channel}:maybe-thread:${messageTs}`
      : messageTs && !message.channel.startsWith("D")
        ? `${message.channel}:${messageTs}`
        : message.channel;
  return `slack:${accountId}:${teamId ? `${teamId}:` : ""}${threadKey}:${senderId}`;
}
