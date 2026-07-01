// Msteams plugin module implements sent message cache behavior.
import { getOptionalMSTeamsRuntime } from "./runtime.js";

const TTL_MS = 24 * 60 * 60 * 1000;
const PERSISTENT_MAX_ENTRIES = 1000;
const PERSISTENT_NAMESPACE = "msteams.sent-messages";
const MSTEAMS_SENT_MESSAGES_KEY = Symbol.for("openclaw.msteamsSentMessages");

type MSTeamsSentMessageRecord = {
  sentAt: number;
};

type MSTeamsSentMessageStore = {
  register(key: string, value: MSTeamsSentMessageRecord, opts?: { ttlMs?: number }): Promise<void>;
  lookup(key: string): Promise<MSTeamsSentMessageRecord | undefined>;
};

type MSTeamsSentMessageScope = {
  accountId?: string | null;
};

let sentMessageCache: Map<string, Map<string, number>> | undefined;
let persistentStore: MSTeamsSentMessageStore | undefined;
let persistentStoreDisabled = false;

function getSentMessageCache(): Map<string, Map<string, number>> {
  if (!sentMessageCache) {
    const globalStore = globalThis as Record<PropertyKey, unknown>;
    sentMessageCache =
      (globalStore[MSTEAMS_SENT_MESSAGES_KEY] as Map<string, Map<string, number>> | undefined) ??
      new Map<string, Map<string, number>>();
    globalStore[MSTEAMS_SENT_MESSAGES_KEY] = sentMessageCache;
  }
  return sentMessageCache;
}

function normalizeSentMessageAccountId(accountId?: string | null): string {
  const trimmed = accountId?.trim();
  return trimmed ? trimmed : "default";
}

function makeConversationScopeKey(
  conversationId: string,
  options?: MSTeamsSentMessageScope,
): string {
  return `${normalizeSentMessageAccountId(options?.accountId)}:${conversationId}`;
}

function makePersistentKey(
  conversationId: string,
  messageId: string,
  options?: MSTeamsSentMessageScope,
): string {
  return `${makeConversationScopeKey(conversationId, options)}:${messageId}`;
}

function reportPersistentSentMessageError(error: unknown): void {
  try {
    getOptionalMSTeamsRuntime()
      ?.logging.getChildLogger({ plugin: "msteams", feature: "sent-message-state" })
      .warn("Microsoft Teams persistent sent-message state failed", { error: String(error) });
  } catch {
    // Best effort only: persistent state must never break Teams routing.
  }
}

function disablePersistentSentMessageStore(error: unknown): void {
  persistentStoreDisabled = true;
  persistentStore = undefined;
  reportPersistentSentMessageError(error);
}

function getPersistentSentMessageStore(): MSTeamsSentMessageStore | undefined {
  if (persistentStoreDisabled) {
    return undefined;
  }
  if (persistentStore) {
    return persistentStore;
  }
  const runtime = getOptionalMSTeamsRuntime();
  if (!runtime) {
    return undefined;
  }
  try {
    persistentStore = runtime.state.openKeyedStore<MSTeamsSentMessageRecord>({
      namespace: PERSISTENT_NAMESPACE,
      maxEntries: PERSISTENT_MAX_ENTRIES,
      defaultTtlMs: TTL_MS,
    });
    return persistentStore;
  } catch (error) {
    disablePersistentSentMessageStore(error);
    return undefined;
  }
}

function cleanupExpired(scopeKey: string, entry: Map<string, number>, now: number): void {
  for (const [id, timestamp] of entry) {
    if (now - timestamp > TTL_MS) {
      entry.delete(id);
    }
  }
  if (entry.size === 0) {
    getSentMessageCache().delete(scopeKey);
  }
}

function rememberSentMessageInMemory(
  conversationId: string,
  messageId: string,
  sentAt: number,
  options?: MSTeamsSentMessageScope,
): void {
  const scopeKey = makeConversationScopeKey(conversationId, options);
  const store = getSentMessageCache();
  let entry = store.get(scopeKey);
  if (!entry) {
    entry = new Map<string, number>();
    store.set(scopeKey, entry);
  }
  entry.set(messageId, sentAt);
  if (entry.size > 200) {
    cleanupExpired(scopeKey, entry, sentAt);
  }
}

function rememberPersistentSentMessage(params: {
  conversationId: string;
  messageId: string;
  sentAt: number;
  accountId?: string | null;
}): void {
  const store = getPersistentSentMessageStore();
  if (!store) {
    return;
  }
  void store
    .register(makePersistentKey(params.conversationId, params.messageId, params), {
      sentAt: params.sentAt,
    })
    .catch(disablePersistentSentMessageStore);
}

async function lookupPersistentSentMessage(params: {
  conversationId: string;
  messageId: string;
  accountId?: string | null;
}): Promise<number | undefined> {
  const store = getPersistentSentMessageStore();
  if (!store) {
    return undefined;
  }
  try {
    return (await store.lookup(makePersistentKey(params.conversationId, params.messageId, params)))
      ?.sentAt;
  } catch (error) {
    disablePersistentSentMessageStore(error);
    return undefined;
  }
}

export function recordMSTeamsSentMessage(
  conversationId: string,
  messageId: string,
  options?: MSTeamsSentMessageScope,
): void {
  if (!conversationId || !messageId) {
    return;
  }
  const now = Date.now();
  rememberSentMessageInMemory(conversationId, messageId, now, options);
  rememberPersistentSentMessage({
    conversationId,
    messageId,
    sentAt: now,
    accountId: options?.accountId,
  });
}

export function wasMSTeamsMessageSent(
  conversationId: string,
  messageId: string,
  options?: MSTeamsSentMessageScope,
): boolean {
  const scopeKey = makeConversationScopeKey(conversationId, options);
  const entry = getSentMessageCache().get(scopeKey);
  if (!entry) {
    return false;
  }
  cleanupExpired(scopeKey, entry, Date.now());
  return entry.has(messageId);
}

export async function wasMSTeamsMessageSentWithPersistence(params: {
  conversationId: string;
  messageId: string;
  accountId?: string | null;
}): Promise<boolean> {
  if (!params.conversationId || !params.messageId) {
    return false;
  }
  if (wasMSTeamsMessageSent(params.conversationId, params.messageId, params)) {
    return true;
  }
  const sentAt = await lookupPersistentSentMessage(params);
  if (sentAt == null) {
    return false;
  }
  rememberSentMessageInMemory(params.conversationId, params.messageId, sentAt, params);
  return wasMSTeamsMessageSent(params.conversationId, params.messageId, params);
}

export function clearMSTeamsSentMessageCache(): void {
  getSentMessageCache().clear();
  persistentStore = undefined;
  persistentStoreDisabled = false;
}
