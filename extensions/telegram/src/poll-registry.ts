// Telegram plugin module implements public-poll vote routing registry behavior.
//
// Telegram only emits `poll_answer` updates for non-anonymous (public) polls, and those
// updates do not carry the originating chat/thread. We persist a small pollId -> origin
// map when a public poll is sent so an inbound vote can be routed back into the right
// session. Storage goes through the shared plugin runtime keyed-state store, the same
// pattern as the other Telegram caches (update-offset, topic-name, bot-info). The cap is
// intentionally small; if a very old poll falls out, the later vote is ignored safely.
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { normalizeAccountId } from "openclaw/plugin-sdk/routing";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { getTelegramRuntime } from "./runtime.js";

export const TELEGRAM_POLL_REGISTRY_NAMESPACE = "telegram.poll-registry";
export const TELEGRAM_POLL_REGISTRY_MAX_ENTRIES = 100;

export type TelegramPollRegistryEntry = {
  pollId: string;
  chatId: string;
  messageThreadId?: number;
  question: string;
  options: string[];
  createdAt: number;
};

type TelegramPollRegistryStore = PluginStateKeyedStore<TelegramPollRegistryEntry>;

let pollRegistryStoreForTest: TelegramPollRegistryStore | undefined;

function openPollRegistryStore(env?: NodeJS.ProcessEnv): TelegramPollRegistryStore {
  return (
    pollRegistryStoreForTest ??
    getTelegramRuntime().state.openKeyedStore<TelegramPollRegistryEntry>({
      namespace: TELEGRAM_POLL_REGISTRY_NAMESPACE,
      maxEntries: TELEGRAM_POLL_REGISTRY_MAX_ENTRIES,
      ...(env ? { env } : {}),
    })
  );
}

// Public poll ids are globally unique, but keying by account keeps registries isolated
// per bot account and mirrors the other Telegram keyed stores.
function pollRegistryKey(accountId: string | undefined, pollId: string): string {
  return `${normalizeAccountId(accountId)}:${pollId}`;
}

function normalizePollRegistryEntry(raw: unknown): TelegramPollRegistryEntry | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const entry = raw as {
    pollId?: unknown;
    chatId?: unknown;
    messageThreadId?: unknown;
    question?: unknown;
    options?: unknown;
    createdAt?: unknown;
  };
  if (
    typeof entry.pollId !== "string" ||
    typeof entry.chatId !== "string" ||
    typeof entry.question !== "string" ||
    !Array.isArray(entry.options) ||
    !entry.options.every((option) => typeof option === "string") ||
    typeof entry.createdAt !== "number" ||
    !Number.isFinite(entry.createdAt) ||
    (entry.messageThreadId != null &&
      (typeof entry.messageThreadId !== "number" || !Number.isFinite(entry.messageThreadId)))
  ) {
    return null;
  }
  return {
    pollId: entry.pollId,
    chatId: entry.chatId,
    messageThreadId:
      typeof entry.messageThreadId === "number" ? Math.floor(entry.messageThreadId) : undefined,
    question: entry.question,
    options: entry.options,
    createdAt: Math.floor(entry.createdAt),
  };
}

export async function recordTelegramPollRegistryEntry(params: {
  accountId?: string;
  pollId: string;
  chatId: string;
  messageThreadId?: number;
  question: string;
  options: string[];
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  // The keyed store persists JSON and rejects explicit `undefined`, so only include the
  // optional thread id when it is actually present.
  const entry: TelegramPollRegistryEntry = {
    pollId: params.pollId,
    chatId: params.chatId,
    question: params.question,
    options: [...params.options],
    createdAt: Date.now(),
    ...(typeof params.messageThreadId === "number"
      ? { messageThreadId: Math.floor(params.messageThreadId) }
      : {}),
  };
  await openPollRegistryStore(params.env).register(
    pollRegistryKey(params.accountId, params.pollId),
    entry,
  );
}

export async function findTelegramPollRegistryEntry(params: {
  accountId?: string;
  pollId: string;
  env?: NodeJS.ProcessEnv;
}): Promise<TelegramPollRegistryEntry | null> {
  let stored: TelegramPollRegistryEntry | undefined;
  try {
    stored = await openPollRegistryStore(params.env).lookup(
      pollRegistryKey(params.accountId, params.pollId),
    );
  } catch (err) {
    // A missing entry resolves to `undefined` (not an error); read failures are logged
    // and treated as no entry so a bad store read cannot crash the update handler.
    logVerbose(
      `telegram: failed to read poll registry for poll ${params.pollId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return null;
  }
  return normalizePollRegistryEntry(stored);
}

export function setTelegramPollRegistryStoreForTest(
  store: TelegramPollRegistryStore | undefined,
): void {
  pollRegistryStoreForTest = store;
}
