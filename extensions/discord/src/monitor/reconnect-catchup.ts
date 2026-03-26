import type { Client } from "@buape/carbon";
import { Message, User } from "@buape/carbon";
import type { APIMessage, GatewayMessageCreateDispatchData } from "discord-api-types/v10";
import type { DiscordGuildEntryResolved } from "./allow-list.js";
import type { DiscordMessageEvent } from "./listeners.js";

/**
 * Collect all channel IDs from guild config that have `allow !== false`.
 */
export function collectMonitoredChannelIds(
  guildEntries?: Record<string, DiscordGuildEntryResolved>,
): string[] {
  const ids: string[] = [];
  if (!guildEntries) return ids;
  for (const guild of Object.values(guildEntries)) {
    const channels = guild.channels;
    if (!channels) continue;
    for (const [channelId, channelCfg] of Object.entries(channels)) {
      if (channelCfg?.allow !== false) {
        ids.push(channelId);
      }
    }
  }
  return ids;
}

/**
 * Resolve the effective `requireMention` setting for a channel,
 * falling back to the guild-level setting.
 */
export function resolveChannelRequireMention(
  channelId: string,
  guildEntries?: Record<string, DiscordGuildEntryResolved>,
): boolean {
  if (!guildEntries) return false;
  for (const guild of Object.values(guildEntries)) {
    const ch = guild.channels?.[channelId];
    if (ch) {
      return ch.requireMention ?? guild.requireMention ?? false;
    }
  }
  return false;
}

/**
 * Filter REST API messages to only those missed during the disconnect gap.
 * Filters out: bot's own messages, messages before the gap, and (if
 * requireMention) messages that don't @mention the bot.
 */
export function filterMissedMessages(
  messages: APIMessage[],
  opts: {
    botUserId?: string;
    afterTimestamp: number;
    requireMention: boolean;
  },
): APIMessage[] {
  return messages.filter((msg) => {
    // Skip bot's own messages
    if (opts.botUserId && msg.author.id === opts.botUserId) return false;

    // Skip messages from before the gap
    const msgTimestamp = new Date(msg.timestamp).getTime();
    if (msgTimestamp <= opts.afterTimestamp) return false;

    // Check if channel requires mention
    if (opts.requireMention) {
      const mentioned = msg.mentions?.some((u) => u.id === opts.botUserId) ?? false;
      if (!mentioned) return false;
    }

    return true;
  });
}

/**
 * Build a Carbon-compatible DiscordMessageEvent from a REST API message,
 * suitable for passing directly to the message handler.
 */
export function buildCatchupEvent(msg: APIMessage, client: Client): DiscordMessageEvent {
  const rawData = msg as unknown as GatewayMessageCreateDispatchData;
  return {
    ...rawData,
    message: new Message(client, msg),
    author: new User(client, msg.author),
    rawMessage: rawData,
    rawAuthor: rawData.author,
    rawMember: rawData.member,
  } as DiscordMessageEvent;
}
