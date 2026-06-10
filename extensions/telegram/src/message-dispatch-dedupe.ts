// Telegram plugin module implements message dispatch dedupe behavior.
import path from "node:path";
import type { Message } from "grammy/types";
import { createClaimableDedupe, type ClaimableDedupe } from "openclaw/plugin-sdk/persistent-dedupe";
import { normalizeStringEntries, uniqueStrings } from "openclaw/plugin-sdk/string-coerce-runtime";

export const TELEGRAM_MESSAGE_DISPATCH_DEDUPE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const TELEGRAM_MESSAGE_DISPATCH_DEDUPE_NAMESPACE = "global";
export const TELEGRAM_MESSAGE_DISPATCH_DEDUPE_NAMESPACE_PREFIX = "telegram.message-dispatch-dedupe";
export const TELEGRAM_MESSAGE_DISPATCH_DEDUPE_STATE_PLUGIN_ID = "telegram-message-dispatch-dedupe";
export const TELEGRAM_MESSAGE_DISPATCH_DEDUPE_MEMORY_MAX_ENTRIES = 50_000;
export const TELEGRAM_MESSAGE_DISPATCH_DEDUPE_STATE_MAX_ENTRIES = 50_000;

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

export function buildTelegramMessageDispatchAccountReplayKey(params: {
  accountId: string;
  key: string;
}): string {
  return JSON.stringify(["account", params.accountId, params.key]);
}

function buildTelegramMessageDispatchStoredReplayKey(params: {
  accountId: string;
  msg: Message;
}): string | null {
  const key = buildTelegramMessageDispatchReplayKey(params.msg);
  return key
    ? buildTelegramMessageDispatchAccountReplayKey({ accountId: params.accountId, key })
    : null;
}

export function createTelegramMessageDispatchReplayGuard(
  params: {
    onDiskError?: (error: unknown) => void;
  } = {},
): TelegramMessageDispatchReplayGuard {
  return createClaimableDedupe({
    ttlMs: TELEGRAM_MESSAGE_DISPATCH_DEDUPE_TTL_MS,
    memoryMaxSize: TELEGRAM_MESSAGE_DISPATCH_DEDUPE_MEMORY_MAX_ENTRIES,
    pluginId: TELEGRAM_MESSAGE_DISPATCH_DEDUPE_STATE_PLUGIN_ID,
    namespacePrefix: TELEGRAM_MESSAGE_DISPATCH_DEDUPE_NAMESPACE_PREFIX,
    stateMaxEntries: TELEGRAM_MESSAGE_DISPATCH_DEDUPE_STATE_MAX_ENTRIES,
    ...(params.onDiskError ? { onDiskError: params.onDiskError } : {}),
  });
}

export async function claimTelegramMessageDispatchReplay(params: {
  guard: TelegramMessageDispatchReplayGuard;
  accountId: string;
  msg: Message;
}): Promise<TelegramMessageDispatchClaim> {
  const key = buildTelegramMessageDispatchStoredReplayKey({
    accountId: params.accountId,
    msg: params.msg,
  });
  if (!key) {
    return { kind: "invalid" };
  }

  let releaseRetries = 0;
  while (true) {
    const claim = await params.guard.claim(key, {
      namespace: TELEGRAM_MESSAGE_DISPATCH_DEDUPE_NAMESPACE,
    });
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
  keys?: readonly string[];
}): Promise<void> {
  const keys = normalizeReplayKeys(params.keys);
  await Promise.all(
    keys.map((key) =>
      params.guard.commit(key, { namespace: TELEGRAM_MESSAGE_DISPATCH_DEDUPE_NAMESPACE }),
    ),
  );
}

export function releaseTelegramMessageDispatchReplay(params: {
  guard: TelegramMessageDispatchReplayGuard;
  keys?: readonly string[];
  error?: unknown;
}): void {
  const keys = normalizeReplayKeys(params.keys);
  for (const key of keys) {
    params.guard.release(key, {
      namespace: TELEGRAM_MESSAGE_DISPATCH_DEDUPE_NAMESPACE,
      error: params.error,
    });
  }
}
