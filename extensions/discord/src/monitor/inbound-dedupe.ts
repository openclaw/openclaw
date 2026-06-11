// Discord plugin module implements inbound dedupe behavior.
import { createClaimableDedupe, type ClaimableDedupe } from "openclaw/plugin-sdk/persistent-dedupe";
import type { DiscordMessageEvent } from "./listeners.js";
import { resolveDiscordMessageChannelId } from "./message-utils.js";

const RECENT_DISCORD_MESSAGE_TTL_MS = 5 * 60_000;
const RECENT_DISCORD_MESSAGE_MAX = 5000;

export function createDiscordInboundReplayGuard(): ClaimableDedupe {
  return createClaimableDedupe({
    ttlMs: RECENT_DISCORD_MESSAGE_TTL_MS,
    memoryMaxSize: RECENT_DISCORD_MESSAGE_MAX,
  });
}

export class DiscordRetryableInboundError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DiscordRetryableInboundError";
  }
}

// Shared by the inbound replay guard and the run-cancellation index so a
// MESSAGE_DELETE event can address the exact run its source message started.
export function buildDiscordInboundCancelKey(params: {
  accountId: string;
  channelId: string;
  messageId: string;
}): string {
  return `${params.accountId}:${params.channelId}:${params.messageId}`;
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
  return buildDiscordInboundCancelKey({ accountId: params.accountId, channelId, messageId });
}

// Edits reuse the Discord message id, so the base replay key would drop them
// as duplicates; the edit timestamp gives each accepted revision its own claim.
export function buildDiscordInboundEditReplayKey(
  baseReplayKey: string,
  editedTimestamp: string,
): string {
  return `${baseReplayKey}:edit:${editedTimestamp}`;
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
