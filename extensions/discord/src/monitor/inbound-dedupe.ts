import path from "node:path";
import { createClaimableDedupe, type ClaimableDedupe } from "openclaw/plugin-sdk/persistent-dedupe";
import type { DiscordMessageEvent } from "./listeners.js";
import { resolveDiscordMessageChannelId } from "./message-utils.js";

const RECENT_DISCORD_MESSAGE_TTL_MS = 5 * 60_000;
const RECENT_DISCORD_MESSAGE_MAX = 5000;
const RECENT_DISCORD_MESSAGE_FILE_MAX = 50_000;

function sanitizeFileSegment(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "default";
  }
  return trimmed.replace(/[^a-zA-Z0-9_-]/g, "_");
}

export function createDiscordInboundReplayGuard(params?: {
  stateDir?: string;
  onDiskError?: (error: unknown) => void;
}): ClaimableDedupe {
  const stateDir = params?.stateDir?.trim();
  return createClaimableDedupe(
    stateDir
      ? {
          ttlMs: RECENT_DISCORD_MESSAGE_TTL_MS,
          memoryMaxSize: RECENT_DISCORD_MESSAGE_MAX,
          fileMaxEntries: RECENT_DISCORD_MESSAGE_FILE_MAX,
          resolveFilePath: (namespace) =>
            path.join(
              stateDir,
              "discord",
              "inbound-replay",
              `${sanitizeFileSegment(namespace)}.json`,
            ),
          onDiskError: params?.onDiskError,
        }
      : {
          ttlMs: RECENT_DISCORD_MESSAGE_TTL_MS,
          memoryMaxSize: RECENT_DISCORD_MESSAGE_MAX,
        },
  );
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
  accountId: string;
  replayKey?: string | null;
  replayGuard: ClaimableDedupe;
}): Promise<boolean> {
  const replayKey = params.replayKey?.trim();
  if (!replayKey) {
    return true;
  }

  let releaseRetries = 0;
  while (true) {
    const claim = await params.replayGuard.claim(replayKey, {
      namespace: params.accountId,
    });
    if (claim.kind === "claimed") {
      return true;
    }
    if (claim.kind === "duplicate") {
      return false;
    }
    try {
      await claim.pending;
      return false;
    } catch {
      releaseRetries += 1;
      if (releaseRetries > 1) {
        return false;
      }
    }
  }
}

export async function commitDiscordInboundReplay(params: {
  accountId: string;
  replayKeys?: readonly (string | null | undefined)[];
  replayGuard: ClaimableDedupe;
}): Promise<void> {
  const replayKeys = normalizeDiscordInboundReplayKeys(params.replayKeys);
  await Promise.all(
    replayKeys.map((replayKey) =>
      params.replayGuard.commit(replayKey, {
        namespace: params.accountId,
      }),
    ),
  );
}

export function releaseDiscordInboundReplay(params: {
  accountId: string;
  replayKeys?: readonly (string | null | undefined)[];
  replayGuard: ClaimableDedupe;
  error?: unknown;
}): void {
  const replayKeys = normalizeDiscordInboundReplayKeys(params.replayKeys);
  replayKeys.forEach((replayKey) =>
    params.replayGuard.release(replayKey, {
      namespace: params.accountId,
      error: params.error,
    }),
  );
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
