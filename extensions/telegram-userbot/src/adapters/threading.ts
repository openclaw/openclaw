/**
 * Threading adapter for the telegram-userbot channel.
 *
 * Provides reply-to-mode resolution and tool context building for
 * Telegram conversations. Supports forum topic threads in supergroups
 * by mapping MessageThreadId to the topic context.
 */

import type { ChannelThreadingAdapter } from "openclaw/plugin-sdk";

export const telegramUserbotThreadingAdapter: ChannelThreadingAdapter = {
  resolveReplyToMode: () => "all",

  allowExplicitReplyTagsWhenOff: true,

  buildToolContext: ({ context, hasRepliedRef }) => {
    const target = context.To?.trim();
    // Strip channel prefix if present
    const currentChannelId = target?.replace(/^telegram-userbot:/i, "") || undefined;

    // Forum topics: if MessageThreadId is set, it's a topic thread
    const threadTs = context.MessageThreadId != null ? String(context.MessageThreadId) : undefined;

    return {
      currentChannelId,
      currentChannelProvider: "telegram-userbot" as never,
      currentThreadTs: threadTs,
      currentMessageId: context.CurrentMessageId,
      replyToMode: "all",
      hasRepliedRef,
    };
  },
};
