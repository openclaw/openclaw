import { type APIMessage } from "discord-api-types/v10";
import { danger } from "openclaw/plugin-sdk/runtime-env";
import { listChannelMessages } from "../internal/api.messages.js";
import { Guild, type Client, Message, User } from "../internal/discord.js";
import { listRecentDiscordOutboundMessages } from "../recent-outbound.js";
import type { DiscordMessageEvent, DiscordMessageHandler } from "./listeners.js";

const RECENT_OUTBOUND_BACKFILL_WINDOW_MS = 15 * 60 * 1000;
const RECENT_OUTBOUND_BACKFILL_LIMIT = 50;
const RECENT_OUTBOUND_BACKFILL_COOLDOWN_MS = 30 * 1000;

type Logger = ReturnType<typeof import("openclaw/plugin-sdk/runtime-env").createSubsystemLogger>;

type DiscordChannelLike = {
  guildId?: string;
  guild_id?: string;
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

function shouldSkipRecentBackfill(params: {
  accountId: string;
  channelId: string;
  messageId: string;
  now: number;
}) {
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
  if (recent.length === 0) {
    return;
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
      continue;
    }
    try {
      const channel = await params.client.fetchChannel(entry.channelId);
      const guildId = resolveGuildId(channel);
      const messages = await listChannelMessages(params.client.rest, entry.channelId, {
        after: entry.messageId,
        limit: RECENT_OUTBOUND_BACKFILL_LIMIT,
      });
      const candidates = messages
        .filter((message) => message.id && !isFromBot(message, params.botUserId))
        .toSorted((a, b) => compareSnowflakesAscending(a.id, b.id));
      if (candidates.length === 0) {
        continue;
      }
      params.logger?.info("Discord reconnect backfill scanning recent channel messages", {
        channelId: entry.channelId,
        count: candidates.length,
      });
      for (const message of candidates) {
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
      }
    } catch (err) {
      params.logger?.error(
        danger(`discord reconnect backfill failed for channel ${entry.channelId}: ${String(err)}`),
      );
    }
  }
}

export function resetRecentDiscordBackfillsForTest() {
  recentBackfillByKey.clear();
}
