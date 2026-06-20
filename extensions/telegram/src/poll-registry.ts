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
import { getTelegramRuntime } from "./runtime.js";

const TELEGRAM_POLL_REGISTRY_NAMESPACE = "telegram.poll-registry";
const TELEGRAM_POLL_REGISTRY_MAX_ENTRIES = 100;

type TelegramPollRegistryEntry = {
  pollId: string;
  chatId: string;
  messageThreadId?: number;
  question: string;
  options: string[];
  createdAt: number;
};

type TelegramPollRegistryStore = PluginStateKeyedStore<TelegramPollRegistryEntry>;

function openPollRegistryStore(env?: NodeJS.ProcessEnv): TelegramPollRegistryStore {
  return getTelegramRuntime().state.openKeyedStore<TelegramPollRegistryEntry>({
    namespace: TELEGRAM_POLL_REGISTRY_NAMESPACE,
    maxEntries: TELEGRAM_POLL_REGISTRY_MAX_ENTRIES,
    ...(env ? { env } : {}),
  });
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
  const numericChatId = typeof entry.chatId === "string" ? Number(entry.chatId) : Number.NaN;
  if (
    typeof entry.pollId !== "string" ||
    typeof entry.chatId !== "string" ||
    !Number.isSafeInteger(numericChatId) ||
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
  // Missing entries resolve to `undefined`; real store failures must propagate so
  // durable Telegram ingress can release the claim and retry the poll_answer.
  const stored = await openPollRegistryStore(params.env).lookup(
    pollRegistryKey(params.accountId, params.pollId),
  );
  return normalizePollRegistryEntry(stored);
}
