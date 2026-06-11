import type { APIMessage } from "discord-api-types/v10";
import { danger } from "openclaw/plugin-sdk/runtime-env";
import { listChannelMessages } from "../internal/api.messages.js";
import { Guild, type Client, Message, User } from "../internal/discord.js";
import {
  hasRecentDiscordInboundMessage,
  recordRecentDiscordInboundMessage,
} from "../recent-inbound.js";
import { listRecentDiscordOutboundMessages } from "../recent-outbound.js";
import type { DiscordMessageEvent, DiscordMessageHandler } from "./listeners.types.js";

const RECENT_OUTBOUND_BACKFILL_WINDOW_MS = 2 * 60 * 60 * 1000;
const RECENT_OUTBOUND_BACKFILL_LIMIT = 50;
const RECENT_OUTBOUND_BACKFILL_COOLDOWN_MS = 30 * 1000;

type Logger = ReturnType<typeof import("openclaw/plugin-sdk/runtime-env").createSubsystemLogger>;

type DiscordChannelLike = {
  guildId?: string;
  guild_id?: string;
};

type DiscordReconnectBackfillStats = {
  anchorsAvailable: number;
  anchorsScanned: number;
  skippedCooldown: number;
  channelsScanned: number;
  candidates: number;
  skippedAlreadyProcessed: number;
  replayed: number;
  errors: number;
};

const recentBackfillByKey = new Map<string, number>();

function normalize(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function compareSnowflakesAscending(a: string, b: string): number {
  try {
    const left = BigInt(a);
    const right = BigInt(b);
    return left < right ? -1 : left > right ? 1 : 0;
  } catch {
    return a.localeCompare(b);
  }
}

function resolveGuildId(channel: unknown): string | undefined {
  const candidate = channel as DiscordChannelLike | null | undefined;
  return normalize(candidate?.guildId) ?? normalize(candidate?.guild_id);
}

function isFromBot(message: APIMessage, botUserId?: string): boolean {
  return Boolean(botUserId && message.author?.id === botUserId);
}

function backfillKey(params: { accountId: string; channelId: string; messageId: string }) {
  return `${params.accountId || "default"}:${params.channelId}:${params.messageId}`;
}

function pruneExpiredRecentBackfillCooldowns(now: number) {
  for (const [key, previous] of recentBackfillByKey) {
    if (now - previous > RECENT_OUTBOUND_BACKFILL_COOLDOWN_MS) {
      recentBackfillByKey.delete(key);
    }
  }
}

function shouldSkipRecentBackfill(params: {
  accountId: string;
  channelId: string;
  messageId: string;
  now: number;
}) {
  pruneExpiredRecentBackfillCooldowns(params.now);
  const key = backfillKey(params);
  const previous = recentBackfillByKey.get(key);
  if (previous !== undefined && params.now - previous <= RECENT_OUTBOUND_BACKFILL_COOLDOWN_MS) {
    return true;
  }
  recentBackfillByKey.set(key, params.now);
  return false;
}

function toDispatchEvent(params: {
  client: Client;
  channelId: string;
  guildId?: string;
  message: APIMessage;
}): DiscordMessageEvent {
  const rawMessage = {
    ...params.message,
    channel_id: params.channelId,
    ...(params.guildId ? { guild_id: params.guildId } : {}),
  } as APIMessage & {
    member?: { roles?: string[]; nick?: string | null; nickname?: string | null };
  };
  const message = new Message(params.client, rawMessage);
  return {
    ...rawMessage,
    id: rawMessage.id,
    channel_id: params.channelId,
    channelId: params.channelId,
    message,
    author: rawMessage.author ? new User(params.client, rawMessage.author) : null,
    member: rawMessage.member,
    rawMember: rawMessage.member,
    guild: params.guildId ? new Guild<true>(params.client, params.guildId) : null,
  } as DiscordMessageEvent;
}

function createEmptyStats(anchorsAvailable: number): DiscordReconnectBackfillStats {
  return {
    anchorsAvailable,
    anchorsScanned: 0,
    skippedCooldown: 0,
    channelsScanned: 0,
    candidates: 0,
    skippedAlreadyProcessed: 0,
    replayed: 0,
    errors: 0,
  };
}

function logBackfillStats(params: { logger?: Logger; stats: DiscordReconnectBackfillStats }) {
  const { stats } = params;
  if (stats.anchorsAvailable === 0) {
    return;
  }
  params.logger?.info("Discord reconnect backfill complete", stats);
}

export async function backfillRecentDiscordInboundMessages(params: {
  accountId: string;
  client: Client;
  messageHandler: DiscordMessageHandler;
  botUserId?: string;
  logger?: Logger;
  onEvent?: () => void;
  now?: number;
}) {
  const now = params.now ?? Date.now();
  const recent = listRecentDiscordOutboundMessages({
    accountId: params.accountId,
    maxAgeMs: RECENT_OUTBOUND_BACKFILL_WINDOW_MS,
    now,
  });
  const stats = createEmptyStats(recent.length);
  if (recent.length === 0) {
    return stats;
  }

  for (const entry of recent) {
    if (
      shouldSkipRecentBackfill({
        accountId: params.accountId,
        channelId: entry.channelId,
        messageId: entry.messageId,
        now,
      })
    ) {
      stats.skippedCooldown += 1;
      continue;
    }
    stats.anchorsScanned += 1;
    try {
      const channel = await params.client.fetchChannel(entry.channelId);
      const guildId = resolveGuildId(channel);
      const messages = await listChannelMessages(params.client.rest, entry.channelId, {
        after: entry.messageId,
        limit: RECENT_OUTBOUND_BACKFILL_LIMIT,
      });
      stats.channelsScanned += 1;
      const candidates = messages
        .filter((message) => message.id && !isFromBot(message, params.botUserId))
        .toSorted((a, b) => compareSnowflakesAscending(a.id, b.id));
      stats.candidates += candidates.length;
      if (candidates.length === 0) {
        continue;
      }
      params.logger?.info("Discord reconnect backfill scanning recent channel messages", {
        channelId: entry.channelId,
        after: entry.messageId,
        count: candidates.length,
      });
      for (const message of candidates) {
        if (
          hasRecentDiscordInboundMessage({
            accountId: params.accountId,
            channelId: entry.channelId,
            messageId: message.id,
            maxAgeMs: RECENT_OUTBOUND_BACKFILL_WINDOW_MS,
            now,
          })
        ) {
          stats.skippedAlreadyProcessed += 1;
          continue;
        }
        params.onEvent?.();
        await params.messageHandler(
          toDispatchEvent({
            client: params.client,
            channelId: entry.channelId,
            guildId,
            message,
          }),
          params.client,
        );
        recordRecentDiscordInboundMessage({
          accountId: params.accountId,
          channelId: entry.channelId,
          messageId: message.id,
          at: now,
        });
        stats.replayed += 1;
      }
    } catch (err) {
      stats.errors += 1;
      params.logger?.error(
        danger(`discord reconnect backfill failed for channel ${entry.channelId}: ${String(err)}`),
      );
    }
  }
  logBackfillStats({ logger: params.logger, stats });
  return stats;
}

export function resetRecentDiscordBackfillsForTest() {
  recentBackfillByKey.clear();
}

export function getRecentDiscordBackfillCooldownCountForTest() {
  return recentBackfillByKey.size;
}
