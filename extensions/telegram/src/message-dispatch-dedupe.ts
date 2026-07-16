// Telegram plugin module implements message dispatch dedupe behavior.
import path from "node:path";
import type { Message } from "grammy/types";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { createChannelReplayGuard } from "openclaw/plugin-sdk/persistent-dedupe";

export const TELEGRAM_MESSAGE_DISPATCH_DEDUPE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const TELEGRAM_MESSAGE_DISPATCH_DEDUPE_NAMESPACE = "global";
export const TELEGRAM_MESSAGE_DISPATCH_DEDUPE_NAMESPACE_PREFIX = "telegram.message-dispatch-dedupe";
export const TELEGRAM_MESSAGE_DISPATCH_DEDUPE_STATE_PLUGIN_ID = "telegram-message-dispatch-dedupe";
const TELEGRAM_MESSAGE_DISPATCH_DEDUPE_MEMORY_MAX_ENTRIES = 50_000;
export const TELEGRAM_MESSAGE_DISPATCH_DEDUPE_STATE_MAX_ENTRIES = 50_000;

type TelegramMessageDispatchClaim =
  | { kind: "claimed"; key: string }
  | { kind: "duplicate" }
  | { kind: "invalid" };

type TelegramMessageDispatchReplayForgetFailure = {
  key: string;
  error?: unknown;
};

class TelegramMessageDispatchReplayForgetError extends Error {
  readonly failures: TelegramMessageDispatchReplayForgetFailure[];
  override readonly cause: unknown;

  constructor(failures: readonly TelegramMessageDispatchReplayForgetFailure[]) {
    const count = failures.length;
    super(`telegram message dispatch dedupe rollback failed for ${count} key(s)`, {
      cause: failures.find((failure) => failure.error !== undefined)?.error,
    });
    this.name = "TelegramMessageDispatchReplayForgetError";
    this.failures = [...failures];
    this.cause = failures.find((failure) => failure.error !== undefined)?.error;
  }
}

export function isTelegramMessageDispatchReplayForgetError(
  error: unknown,
): error is TelegramMessageDispatchReplayForgetError {
  return error instanceof TelegramMessageDispatchReplayForgetError;
}

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

function buildTelegramMessageDispatchReplayKey(msg: Message): string | null {
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

type TelegramMessageDispatchReplayEvent =
  | { accountId: string; msg: Message }
  | { keys?: readonly string[] };

export function createTelegramMessageDispatchReplayGuard(
  params: {
    onDiskError?: (error: unknown) => void;
  } = {},
) {
  return createChannelReplayGuard<TelegramMessageDispatchReplayEvent>({
    dedupe: {
      ttlMs: TELEGRAM_MESSAGE_DISPATCH_DEDUPE_TTL_MS,
      memoryMaxSize: TELEGRAM_MESSAGE_DISPATCH_DEDUPE_MEMORY_MAX_ENTRIES,
      pluginId: TELEGRAM_MESSAGE_DISPATCH_DEDUPE_STATE_PLUGIN_ID,
      namespacePrefix: TELEGRAM_MESSAGE_DISPATCH_DEDUPE_NAMESPACE_PREFIX,
      stateMaxEntries: TELEGRAM_MESSAGE_DISPATCH_DEDUPE_STATE_MAX_ENTRIES,
      ...(params.onDiskError ? { onDiskError: params.onDiskError } : {}),
    },
    buildReplayKey: (event) =>
      "msg" in event ? buildTelegramMessageDispatchStoredReplayKey(event) : (event.keys ?? []),
    namespace: () => TELEGRAM_MESSAGE_DISPATCH_DEDUPE_NAMESPACE,
  });
}

type TelegramMessageDispatchReplayGuard = Pick<
  ReturnType<typeof createTelegramMessageDispatchReplayGuard>,
  "claim" | "commit" | "release" | "forget" | "warmup"
>;

export async function claimTelegramMessageDispatchReplay(params: {
  guard: TelegramMessageDispatchReplayGuard;
  accountId: string;
  msg: Message;
}): Promise<TelegramMessageDispatchClaim> {
  let releaseRetries = 0;
  while (true) {
    const claim = await params.guard.claim({
      accountId: params.accountId,
      msg: params.msg,
    });
    if (claim.kind === "claimed") {
      return { kind: "claimed", key: claim.keys[0] };
    }
    if (claim.kind === "duplicate" || claim.kind === "invalid") {
      return claim;
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

export async function commitTelegramMessageDispatchReplay(params: {
  guard: TelegramMessageDispatchReplayGuard;
  keys?: readonly string[];
  /** Require every claim to reach SQLite before the caller acknowledges durable adoption. */
  requirePersistent?: boolean;
}): Promise<void> {
  const keys = [...new Set((params.keys ?? []).map((key) => key.trim()).filter(Boolean))];
  const committedKeys: string[] = [];
  // Commit serially so a later failure has no still-running sibling write that
  // can race rollback and recreate a key after it was forgotten.
  for (const [index, key] of keys.entries()) {
    let diskError: unknown;
    try {
      const recorded = await params.guard.commit(
        { keys: [key] },
        params.requirePersistent === true
          ? {
              namespace: TELEGRAM_MESSAGE_DISPATCH_DEDUPE_NAMESPACE,
              onDiskError: (error) => {
                diskError = error;
              },
            }
          : { namespace: TELEGRAM_MESSAGE_DISPATCH_DEDUPE_NAMESPACE },
      );
      if (params.requirePersistent === true && diskError !== undefined) {
        throw diskError instanceof Error
          ? diskError
          : new Error(formatErrorMessage(diskError), { cause: diskError });
      }
      if (recorded) {
        committedKeys.push(key);
      }
    } catch (error) {
      for (const pendingKey of keys.slice(index + 1)) {
        params.guard.release({ keys: [pendingKey] }, { error });
      }

      const failures: TelegramMessageDispatchReplayForgetFailure[] = [];
      for (const committedKey of committedKeys) {
        try {
          const forgotten = await params.guard.forget({ keys: [committedKey] });
          if (!forgotten) {
            failures.push({ key: committedKey });
          }
        } catch (rollbackError) {
          failures.push({ key: committedKey, error: rollbackError });
        }
      }

      let failedKeyCleanupError: unknown;
      try {
        await params.guard.forget(
          { keys: [key] },
          {
            onDiskError: (rollbackError) => {
              failedKeyCleanupError = rollbackError;
            },
          },
        );
      } catch (rollbackError) {
        failedKeyCleanupError = rollbackError;
      }
      if (failedKeyCleanupError !== undefined) {
        failures.push({ key, error: failedKeyCleanupError });
      }
      if (failures.length > 0) {
        throw new TelegramMessageDispatchReplayForgetError(failures);
      }
      throw error;
    }
  }
}

export function releaseTelegramMessageDispatchReplay(params: {
  guard: TelegramMessageDispatchReplayGuard;
  keys?: readonly string[];
  error?: unknown;
}): void {
  params.guard.release({ keys: params.keys }, { error: params.error });
}
