// Discord plugin module implements inbound dedupe behavior.
import { getChildLogger } from "openclaw/plugin-sdk/logging-core";
import { createClaimableDedupe, type ClaimableDedupe } from "openclaw/plugin-sdk/persistent-dedupe";
import type { DiscordMessageEvent } from "./listeners.js";
import { resolveDiscordMessageChannelId } from "./message-utils.js";

// Persisted so a committed inbound key still dedupes after a gateway restart:
// Discord's gateway resume replays recently-dispatched messages, and a
// memory-only guard would re-dispatch them. Mirrors imessage/telegram inbound
// dedupe. claim = in-memory ownership; commit = persisted; release = reclaimable.
const DISCORD_INBOUND_DEDUPE_PLUGIN_ID = "discord";
const DISCORD_INBOUND_DEDUPE_NAMESPACE_PREFIX = "discord.inbound-dedupe";
// 5min recency absorbs a resume/replay burst; short enough that a genuinely new
// message reusing a stale key after minutes is not wrongly suppressed.
const RECENT_DISCORD_MESSAGE_TTL_MS = 5 * 60_000;
const RECENT_DISCORD_MESSAGE_MAX = 5000;
// Bounds persisted rows per namespace (SQLite growth cap).
const DISCORD_INBOUND_DEDUPE_STATE_MAX_ENTRIES = 10_000;

export function createDiscordInboundReplayGuard(): ClaimableDedupe {
  return createClaimableDedupe({
    pluginId: DISCORD_INBOUND_DEDUPE_PLUGIN_ID,
    namespacePrefix: DISCORD_INBOUND_DEDUPE_NAMESPACE_PREFIX,
    ttlMs: RECENT_DISCORD_MESSAGE_TTL_MS,
    memoryMaxSize: RECENT_DISCORD_MESSAGE_MAX,
    stateMaxEntries: DISCORD_INBOUND_DEDUPE_STATE_MAX_ENTRIES,
    // Persistent dedupe fails open on storage errors; without this hook a
    // broken state DB silently downgrades to memory-only (restart replays return).
    onDiskError: (error) => {
      getChildLogger({ module: "discord" }).warn(
        { error: String(error) },
        "discord inbound replay dedupe storage failed",
      );
    },
  });
}

export class DiscordRetryableInboundError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DiscordRetryableInboundError";
  }
}

export function buildDiscordInboundReplayKey(params: {
  accountId: string;
  data: DiscordMessageEvent;
}): string | null {
  const messageId = params.data.message?.id?.trim();
  if (!messageId) {
    return null;
  }
  const channelId = resolveDiscordMessageChannelId({
    message: params.data.message,
    eventChannelId: params.data.channel_id,
  });
  if (!channelId) {
    return null;
  }
  return `${params.accountId}:${channelId}:${messageId}`;
}

export async function claimDiscordInboundReplay(params: {
  replayKey?: string | null;
  replayGuard: ClaimableDedupe;
}): Promise<boolean> {
  const replayKey = params.replayKey?.trim();
  if (!replayKey) {
    return true;
  }
  const claim = await params.replayGuard.claim(replayKey);
  return claim.kind === "claimed";
}

export async function commitDiscordInboundReplay(params: {
  replayKeys?: readonly (string | null | undefined)[];
  replayGuard: ClaimableDedupe;
}): Promise<void> {
  const replayKeys = normalizeDiscordInboundReplayKeys(params.replayKeys);
  await Promise.all(replayKeys.map((replayKey) => params.replayGuard.commit(replayKey)));
}

export function releaseDiscordInboundReplay(params: {
  replayKeys?: readonly (string | null | undefined)[];
  replayGuard: ClaimableDedupe;
  error?: unknown;
}): void {
  const replayKeys = normalizeDiscordInboundReplayKeys(params.replayKeys);
  replayKeys.forEach((replayKey) => params.replayGuard.release(replayKey, { error: params.error }));
}

function normalizeDiscordInboundReplayKeys(
  replayKeys?: readonly (string | null | undefined)[],
): string[] {
  return [
    ...new Set(
      (replayKeys ?? [])
        .map((replayKey) => replayKey?.trim())
        .filter((replayKey): replayKey is string => Boolean(replayKey)),
    ),
  ];
}
