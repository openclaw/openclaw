/**
 * Streaming adapter for the telegram-userbot channel.
 *
 * Provides block-streaming coalesce defaults so the agent accumulates
 * enough text before flushing a chunk to Telegram.
 */

import type { ChannelStreamingAdapter } from "openclaw/plugin-sdk";

export const telegramUserbotStreamingAdapter: ChannelStreamingAdapter = {
  blockStreamingCoalesceDefaults: { minChars: 1500, idleMs: 1000 },
};
