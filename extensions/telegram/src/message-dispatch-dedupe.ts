// Telegram plugin module implements message dispatch dedupe behavior.
import path from "node:path";
import type { Message } from "grammy/types";
import { createClaimableDedupe, type ClaimableDedupe } from "openclaw/plugin-sdk/persistent-dedupe";
import { normalizeStringEntries, uniqueStrings } from "openclaw/plugin-sdk/string-coerce-runtime";

export const TELEGRAM_MESSAGE_DISPATCH_DEDUPE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const TELEGRAM_MESSAGE_DISPATCH_DEDUPE_NAMESPACE_PREFIX = "telegram.message-dispatch-dedupe";
export const TELEGRAM_MESSAGE_DISPATCH_DEDUPE_MAX_ENTRIES = 50_000;

export type TelegramMessageDispatchReplayGuard = ClaimableDedupe;

export type TelegramMessageDispatchClaim =
  | { kind: "claimed"; key: string }
  | { kind: "duplicate" }
  | { kind: "invalid" };

function sanitizeFileSegment(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "default";
  }
  return trimmed.replace(/[^a-zA-Z0-9_-]/g, "_");
}

export function resolveTelegramMessageDispatchLegacyPath(params: {
  storePath: string;
  namespace: string;
}): string {
  return path.join(
    path.dirname(params.storePath),
    `${path.basename(params.storePath)}.telegram-message-dispatch-${sanitizeFileSegment(
      params.namespace,
    )}.json`,
  );
}

export function buildTelegramMessageDispatchReplayKey(msg: Message): string | null {
  const chatId = msg.chat?.id;
  const messageId = msg.message_id;
  if (chatId == null || typeof messageId !== "number" || messageId <= 0) {
    return null;
  }
  return JSON.stringify(["message", String(chatId), messageId]);
}

export function createTelegramMessageDispatchReplayGuard(
  params: {
    onDiskError?: (error: unknown) => void;
  } = {},
): TelegramMessageDispatchReplayGuard {
  return createClaimableDedupe({
    ttlMs: TELEGRAM_MESSAGE_DISPATCH_DEDUPE_TTL_MS,
    memoryMaxSize: TELEGRAM_MESSAGE_DISPATCH_DEDUPE_MAX_ENTRIES,
    pluginId: "telegram",
    namespacePrefix: TELEGRAM_MESSAGE_DISPATCH_DEDUPE_NAMESPACE_PREFIX,
    stateMaxEntries: TELEGRAM_MESSAGE_DISPATCH_DEDUPE_MAX_ENTRIES,
    ...(params.onDiskError ? { onDiskError: params.onDiskError } : {}),
  });
}

export async function claimTelegramMessageDispatchReplay(params: {
  guard: TelegramMessageDispatchReplayGuard;
  accountId: string;
  msg: Message;
}): Promise<TelegramMessageDispatchClaim> {
  const key = buildTelegramMessageDispatchReplayKey(params.msg);
  if (!key) {
    return { kind: "invalid" };
  }

  let releaseRetries = 0;
  while (true) {
    const claim = await params.guard.claim(key, { namespace: params.accountId });
    if (claim.kind === "claimed") {
      return { kind: "claimed", key };
    }
    if (claim.kind === "duplicate") {
      return { kind: "duplicate" };
    }
    try {
      await claim.pending;
      return { kind: "duplicate" };
    } catch {
      releaseRetries += 1;
      if (releaseRetries > 1) {
        return { kind: "duplicate" };
      }
    }
  }
}

function normalizeReplayKeys(keys?: readonly string[]): string[] {
  return uniqueStrings(normalizeStringEntries(keys ?? []));
}

export async function commitTelegramMessageDispatchReplay(params: {
  guard: TelegramMessageDispatchReplayGuard;
  accountId: string;
  keys?: readonly string[];
}): Promise<void> {
  const keys = normalizeReplayKeys(params.keys);
  await Promise.all(keys.map((key) => params.guard.commit(key, { namespace: params.accountId })));
}

export function releaseTelegramMessageDispatchReplay(params: {
  guard: TelegramMessageDispatchReplayGuard;
  accountId: string;
  keys?: readonly string[];
  error?: unknown;
}): void {
  const keys = normalizeReplayKeys(params.keys);
  for (const key of keys) {
    params.guard.release(key, { namespace: params.accountId, error: params.error });
  }
}
