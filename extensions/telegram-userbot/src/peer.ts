/**
 * Peer resolution helpers for the telegram-userbot channel.
 *
 * Supports input formats:
 *  1. Numeric ID — e.g. 267619672 or -1001234567890
 *  2. Bigint ID — large Telegram IDs (supergroups/channels)
 *  3. @username  — e.g. "@amazing_nero"
 *  4. OpenClaw target — e.g. "telegram-userbot:267619672"
 */

import type { TelegramClient } from "telegram";
import type { Api } from "telegram/tl/api.js";
import { UserbotPeerError, wrapGramJSError } from "./errors.js";
import type { PeerResolvable } from "./types.js";

const CHANNEL_PREFIX = "telegram-userbot:";

/**
 * Parse the OpenClaw target format "telegram-userbot:XXXX".
 *
 * @returns Object with the channel identifier and numeric peer ID.
 * @throws UserbotPeerError if the target string is not in the expected format.
 */
export function parseTelegramTarget(target: string): { channel: string; peerId: number } {
  if (!target.startsWith(CHANNEL_PREFIX)) {
    throw new UserbotPeerError(
      target,
      new Error(`Expected target to start with "${CHANNEL_PREFIX}"`),
    );
  }

  const raw = target.slice(CHANNEL_PREFIX.length);
  const peerId = Number(raw);

  if (!Number.isFinite(peerId) || raw.length === 0) {
    throw new UserbotPeerError(target, new Error(`Invalid numeric peer ID in target: "${raw}"`));
  }

  return { channel: "telegram-userbot", peerId };
}

/** Parse a PeerResolvable into the value GramJS getInputEntity() accepts. */
export function parsePeerInput(input: PeerResolvable): string | number {
  if (typeof input === "number") {
    return input;
  }
  if (typeof input === "bigint") {
    return Number(input);
  }

  // OpenClaw target format: "telegram-userbot:267619672"
  if (input.startsWith(CHANNEL_PREFIX)) {
    const raw = input.slice(CHANNEL_PREFIX.length);
    const numeric = Number(raw);
    if (!Number.isNaN(numeric) && raw.length > 0) {
      return numeric;
    }
    // Could be a username after the prefix
    return raw.startsWith("@") ? raw : `@${raw}`;
  }

  // @username format
  if (input.startsWith("@")) {
    return input;
  }

  // Plain numeric string
  const numeric = Number(input);
  if (!Number.isNaN(numeric) && input.length > 0) {
    return numeric;
  }

  // Treat as username without @ prefix
  return input;
}

/**
 * Resolve a PeerResolvable into a GramJS InputPeer via the client's entity cache.
 *
 * @throws UserbotPeerError if the peer cannot be resolved
 */
export async function resolvePeer(
  client: TelegramClient,
  input: PeerResolvable,
): Promise<Api.TypeInputPeer> {
  const parsed = parsePeerInput(input);
  try {
    return await client.getInputEntity(parsed);
  } catch (err) {
    if (err instanceof UserbotPeerError) throw err;
    throw new UserbotPeerError(
      typeof input === "bigint" ? Number(input) : input,
      wrapGramJSError(err).cause ?? err,
    );
  }
}

/**
 * Extract a stable numeric chat ID from a PeerResolvable.
 *
 * Returns the numeric ID for numeric/bigint/OpenClaw-prefixed inputs,
 * or undefined for username inputs (need resolution first).
 */
export function extractNumericId(input: PeerResolvable): number | undefined {
  if (typeof input === "number") return input;
  if (typeof input === "bigint") return Number(input);

  if (input.startsWith(CHANNEL_PREFIX)) {
    const raw = input.slice(CHANNEL_PREFIX.length);
    const n = Number(raw);
    return !Number.isNaN(n) && raw.length > 0 ? n : undefined;
  }

  if (input.startsWith("@")) return undefined;

  const n = Number(input);
  return !Number.isNaN(n) && input.length > 0 ? n : undefined;
}

/** Format a numeric chat ID as an OpenClaw target string. */
export function formatTarget(chatId: number): string {
  return `${CHANNEL_PREFIX}${chatId}`;
}
