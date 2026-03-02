/**
 * Streaming adapter for the telegram-userbot channel.
 *
 * Provides block-streaming coalesce defaults so the agent accumulates
 * enough text before flushing a chunk to Telegram, and exposes a
 * `sendTypingIndicator` helper that sends MTProto typing actions via
 * the active UserbotClient.
 */

import type { ChannelStreamingAdapter } from "openclaw/plugin-sdk";
import { getConnectionManager } from "../channel.js";

export const telegramUserbotStreamingAdapter: ChannelStreamingAdapter = {
  blockStreamingCoalesceDefaults: { minChars: 1500, idleMs: 1000 },
};

/**
 * Send a typing indicator to a peer via MTProto.
 *
 * Resolves the active UserbotClient from the ConnectionManager for the
 * given account. If the client is disconnected or the manager is absent,
 * the call is a silent no-op so callers never need to guard connectivity.
 */
export async function sendTypingIndicator(accountId: string, peer: string | number): Promise<void> {
  const manager = getConnectionManager(accountId);
  const client = manager?.getClient();
  if (!client?.isConnected()) return;

  await client.setTyping(peer);
}
