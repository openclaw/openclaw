import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveIMessageChatMatch, type IMessageChatContext } from "./chat-context.js";
import { getIMessageRuntime } from "./runtime.js";
import {
  IMESSAGE_REPLY_CACHE_NAMESPACE,
  IMESSAGE_REPLY_CACHE_MAX_ENTRIES,
  IMESSAGE_REPLY_CACHE_COUNTER_NAMESPACE,
  IMESSAGE_REPLY_CACHE_COUNTER_MAX_ENTRIES,
  IMESSAGE_REPLY_CACHE_COUNTER_KEY,
  IMESSAGE_REPLY_CACHE_TTL_MS,
  resolveIMessageReplyCacheEntryKey,
} from "./state-contract.js";

export type { IMessageChatContext } from "./chat-context.js";

/** Recency window for the "react to the latest message" fallback. */
const LATEST_FALLBACK_MS = 10 * 60 * 1000;
let persistenceFailureLogged = false;
function reportPersistenceFailure(scope: string, err: unknown): void {
  if (persistenceFailureLogged) {
    return;
  }
  persistenceFailureLogged = true;
  logVerbose(`imessage reply-cache: ${scope} disabled after first failure: ${String(err)}`);
}

type IMessageReplyCacheEntry = IMessageChatContext & {
  accountId: string;
  messageId: string;
  shortId: string;
  timestamp: number;
  // Edit/unsend require an outbound record; missing persisted provenance is untrusted.
  isFromMe?: boolean;
};

type IMessageReplyCacheStore = PluginStateKeyedStore<IMessageReplyCacheEntry>;
type IMessageReplyCacheCounter = { counter: number };

const imessageReplyCacheByMessageId = new Map<string, IMessageReplyCacheEntry>();
const imessageShortIdToUuid = new Map<string, string>();
let imessageShortIdCounter = 0;

function openReplyCacheStore(): IMessageReplyCacheStore {
  return getIMessageRuntime().state.openKeyedStore<IMessageReplyCacheEntry>({
    namespace: IMESSAGE_REPLY_CACHE_NAMESPACE,
    maxEntries: IMESSAGE_REPLY_CACHE_MAX_ENTRIES,
  });
}

function openReplyCacheCounterStore(): PluginStateKeyedStore<IMessageReplyCacheCounter> {
  return getIMessageRuntime().state.openKeyedStore<IMessageReplyCacheCounter>({
    namespace: IMESSAGE_REPLY_CACHE_COUNTER_NAMESPACE,
    maxEntries: IMESSAGE_REPLY_CACHE_COUNTER_MAX_ENTRIES,
  });
}

function remainingTtlMs(timestamp: number): number | undefined {
  const remaining = IMESSAGE_REPLY_CACHE_TTL_MS - Math.max(0, Date.now() - timestamp);
  return remaining > 0 ? remaining : undefined;
}

let hydrated = false;
let hydration: Promise<void> | undefined;
let persistence: Promise<void> = Promise.resolve();

function hydrateCounter(counter: IMessageReplyCacheCounter | undefined): void {
  if (counter && Number.isSafeInteger(counter.counter) && counter.counter > 0) {
    imessageShortIdCounter = Math.max(imessageShortIdCounter, counter.counter);
  }
}

function hydrateRows(entries: IMessageReplyCacheEntry[]): void {
  const cutoff = Date.now() - IMESSAGE_REPLY_CACHE_TTL_MS;
  for (const entry of entries
    .filter((cached) => cached.timestamp >= cutoff)
    .toSorted((a, b) => a.timestamp - b.timestamp)
    .slice(-IMESSAGE_REPLY_CACHE_MAX_ENTRIES)) {
    const numeric = Number.parseInt(entry.shortId, 10);
    if (Number.isFinite(numeric) && numeric > imessageShortIdCounter) {
      imessageShortIdCounter = numeric;
    }
    imessageReplyCacheByMessageId.set(entry.messageId, entry);
    imessageShortIdToUuid.set(entry.shortId, entry.messageId);
  }
}

async function hydrateFromStoreOnce(): Promise<void> {
  if (hydrated) {
    return;
  }
  hydration ??= (async () => {
    try {
      const counter = await openReplyCacheCounterStore().lookup(IMESSAGE_REPLY_CACHE_COUNTER_KEY);
      hydrateCounter(counter);
      const entries = await openReplyCacheStore().entries();
      // A legacy host callback can finish synchronous hydration while this read waits.
      if (!hydrated) {
        hydrateRows(entries.map(({ value }) => value));
      }
    } catch (err) {
      reportPersistenceFailure("read", err);
    } finally {
      hydrated = true;
    }
  })();
  await hydration;
}

function hydrateFromStoreOnceSync(): void {
  if (hydrated) {
    return;
  }
  hydrated = true;
  try {
    const state = getIMessageRuntime().state;
    const counter = state
      .openSyncKeyedStore<IMessageReplyCacheCounter>({
        namespace: IMESSAGE_REPLY_CACHE_COUNTER_NAMESPACE,
        maxEntries: IMESSAGE_REPLY_CACHE_COUNTER_MAX_ENTRIES,
      })
      .lookup(IMESSAGE_REPLY_CACHE_COUNTER_KEY);
    hydrateCounter(counter);
    const entries = state
      .openSyncKeyedStore<IMessageReplyCacheEntry>({
        namespace: IMESSAGE_REPLY_CACHE_NAMESPACE,
        maxEntries: IMESSAGE_REPLY_CACHE_MAX_ENTRIES,
      })
      .entries();
    hydrateRows(entries.map(({ value }) => value));
  } catch (err) {
    reportPersistenceFailure("read", err);
  }
}

async function persistReplyCacheEntry(entry: IMessageReplyCacheEntry): Promise<void> {
  const ttlMs = remainingTtlMs(entry.timestamp);
  if (!ttlMs) {
    return;
  }
  try {
    await openReplyCacheStore().register(
      resolveIMessageReplyCacheEntryKey(entry.messageId),
      entry,
      {
        ttlMs,
      },
    );
  } catch (err) {
    reportPersistenceFailure("write", err);
  }
}

async function deleteReplyCacheEntry(messageId: string): Promise<void> {
  try {
    await openReplyCacheStore().delete(resolveIMessageReplyCacheEntryKey(messageId));
  } catch (err) {
    reportPersistenceFailure("delete", err);
  }
}

async function persistReplyCacheCounter(counter: number): Promise<void> {
  try {
    await openReplyCacheCounterStore().register(IMESSAGE_REPLY_CACHE_COUNTER_KEY, { counter });
  } catch (err) {
    reportPersistenceFailure("counter", err);
  }
}

function buildReplyCacheEntry(
  entry: Omit<IMessageReplyCacheEntry, "shortId">,
  messageId: string,
  shortId: string,
): IMessageReplyCacheEntry {
  return {
    accountId: entry.accountId,
    messageId,
    shortId,
    timestamp: entry.timestamp,
    ...(typeof entry.chatGuid === "string" ? { chatGuid: entry.chatGuid } : {}),
    ...(typeof entry.chatIdentifier === "string" ? { chatIdentifier: entry.chatIdentifier } : {}),
    ...(typeof entry.chatId === "number" ? { chatId: entry.chatId } : {}),
    ...(typeof entry.isFromMe === "boolean" ? { isFromMe: entry.isFromMe } : {}),
  };
}

export async function rememberIMessageReplyCache(
  entry: Omit<IMessageReplyCacheEntry, "shortId">,
): Promise<IMessageReplyCacheEntry> {
  await hydrateFromStoreOnce();
  const messageId = entry.messageId.trim();
  if (!messageId) {
    return { ...entry, shortId: "" };
  }

  let shortId = imessageReplyCacheByMessageId.get(messageId)?.shortId;
  const isNewMessage = !shortId;
  if (!shortId) {
    shortId = String(++imessageShortIdCounter);
    imessageShortIdToUuid.set(shortId, messageId);
  }

  const fullEntry = buildReplyCacheEntry(entry, messageId, shortId);
  imessageReplyCacheByMessageId.delete(messageId);
  imessageReplyCacheByMessageId.set(messageId, fullEntry);

  const cutoff = Date.now() - IMESSAGE_REPLY_CACHE_TTL_MS;
  const deletedMessageIds: string[] = [];
  const pruneUntil = (retain: (key: string, cached: IMessageReplyCacheEntry) => boolean) => {
    for (const [key, cached] of imessageReplyCacheByMessageId) {
      if (retain(key, cached)) {
        break;
      }
      imessageReplyCacheByMessageId.delete(key);
      deletedMessageIds.push(key);
      if (cached.shortId) {
        imessageShortIdToUuid.delete(cached.shortId);
      }
    }
  };
  pruneUntil((_key, cached) => cached.timestamp >= cutoff);
  pruneUntil(
    (key) => !key || imessageReplyCacheByMessageId.size <= IMESSAGE_REPLY_CACHE_MAX_ENTRIES,
  );

  const counter = imessageShortIdCounter;
  // Publish memory without yielding, then persist each admitted mutation in order.
  persistence = persistence.then(async () => {
    if (isNewMessage) {
      await persistReplyCacheCounter(counter);
    }
    for (const messageIdToDelete of deletedMessageIds) {
      await deleteReplyCacheEntry(messageIdToDelete);
    }
    await persistReplyCacheEntry(fullEntry);
  });
  await persistence;

  return fullEntry;
}

function hasChatScope(ctx?: IMessageChatContext): boolean {
  if (!ctx) {
    return false;
  }
  return Boolean(
    normalizeOptionalString(ctx.chatGuid) ||
    normalizeOptionalString(ctx.chatIdentifier) ||
    typeof ctx.chatId === "number",
  );
}

function describeChatForError(values: IMessageChatContext): string {
  const parts: string[] = [];
  if (normalizeOptionalString(values.chatGuid)) {
    parts.push("chatGuid=<redacted>");
  }
  if (normalizeOptionalString(values.chatIdentifier)) {
    parts.push("chatIdentifier=<redacted>");
  }
  if (typeof values.chatId === "number") {
    parts.push("chatId=<redacted>");
  }
  return parts.length === 0 ? "<unknown chat>" : parts.join(", ");
}

function describeMessageIdForError(inputId: string, inputKind: "short" | "uuid"): string {
  if (inputKind === "short") {
    return `<short:${inputId.length}-digit>`;
  }
  return `<uuid:${inputId.slice(0, 8)}...>`;
}

function buildCrossChatError(
  inputId: string,
  inputKind: "short" | "uuid",
  cached: IMessageReplyCacheEntry,
  ctx: IMessageChatContext,
): Error {
  const remediation =
    inputKind === "short"
      ? "Use a message ID from the current chat target; MessageSidFull from another chat is rejected."
      : "Retry with the correct chat target.";
  return new Error(
    `iMessage message id ${describeMessageIdForError(inputId, inputKind)} belongs to a different chat ` +
      `(${describeChatForError(cached)}) than the current call target (${describeChatForError(ctx)}). ${remediation}`,
  );
}

export async function resolveIMessageMessageId(
  shortOrUuid: string,
  opts?: {
    requireKnownShortId?: boolean;
    chatContext?: IMessageChatContext;
    /** Reject inbound, uncached, or provenance-free records for edit/unsend. */
    requireFromMe?: boolean;
  },
): Promise<string> {
  const trimmed = shortOrUuid.trim();
  if (!trimmed) {
    return trimmed;
  }
  await hydrateFromStoreOnce();
  const inputKind = /^\d+$/.test(trimmed) ? "short" : "uuid";
  const messageId = inputKind === "short" ? imessageShortIdToUuid.get(trimmed) : trimmed;
  if (!messageId) {
    if (opts?.requireKnownShortId) {
      if (!hasChatScope(opts.chatContext)) {
        throw new Error(
          `iMessage short message id ${describeMessageIdForError(trimmed, "short")} requires a chat scope (chatGuid / chatIdentifier / chatId or a target).`,
        );
      }
      throw new Error(
        `iMessage short message id ${describeMessageIdForError(trimmed, "short")} is no longer available. Use MessageSidFull.`,
      );
    }
    return trimmed;
  }

  const cached = imessageReplyCacheByMessageId.get(messageId);
  if (
    cached &&
    opts?.chatContext &&
    (inputKind === "uuid" || hasChatScope(opts.chatContext)) &&
    resolveIMessageChatMatch(cached, opts.chatContext) === "mismatch"
  ) {
    throw buildCrossChatError(trimmed, inputKind, cached, opts.chatContext);
  }
  if (opts?.requireFromMe && cached?.isFromMe !== true) {
    throw buildFromMeError(trimmed, inputKind);
  }
  return messageId;
}

export async function isKnownFromMeIMessageMessageId(
  messageId: string | undefined,
  ctx: IMessageChatContext & { accountId?: string },
): Promise<boolean> {
  const trimmed = normalizeOptionalString(messageId);
  if (!trimmed || !ctx.accountId || !hasChatScope(ctx)) {
    return false;
  }
  await hydrateFromStoreOnce();
  const cached = imessageReplyCacheByMessageId.get(trimmed);
  if (!cached || cached.isFromMe !== true) {
    return false;
  }
  return resolveCachedResourceBinding(trimmed, { ...ctx, accountId: ctx.accountId }) === "match";
}

export async function isKnownFromMeIMessageTarget(params: {
  messageIds: string[];
  accountId: string;
  chatId?: number;
  chatGuid?: string;
  chatIdentifier?: string;
  isKnownFromMeMessageId?: (
    ...args: Parameters<typeof isKnownFromMeIMessageMessageId>
  ) => boolean | Promise<boolean>;
}): Promise<boolean> {
  const { accountId, chatId, chatGuid, chatIdentifier } = params;
  const ctx = { accountId, chatId, chatGuid, chatIdentifier };
  const isKnownFromMe = params.isKnownFromMeMessageId ?? isKnownFromMeIMessageMessageId;
  for (const messageId of params.messageIds) {
    if (await isKnownFromMe(messageId, ctx)) {
      return true;
    }
  }
  return false;
}

function buildFromMeError(inputId: string, inputKind: "short" | "uuid"): Error {
  return new Error(
    `iMessage message id ${describeMessageIdForError(inputId, inputKind)} is not one this agent sent. ` +
      `edit and unsend can only target messages the gateway delivered itself; ` +
      `messages received from other participants cannot be modified.`,
  );
}

/** Latest recent entry with a positive same-account conversation match; never guess a chat. */
export function findLatestIMessageEntryForChat(
  ctx: IMessageChatContext & { accountId?: string },
): IMessageReplyCacheEntry | undefined {
  if (!hasChatScope(ctx) || !ctx.accountId) {
    return undefined;
  }
  const cutoff = Date.now() - LATEST_FALLBACK_MS;
  let best: IMessageReplyCacheEntry | undefined;
  for (const entry of imessageReplyCacheByMessageId.values()) {
    if (entry.accountId !== ctx.accountId) {
      continue;
    }
    if (entry.timestamp < cutoff) {
      continue;
    }
    if (resolveIMessageChatMatch(entry, ctx) !== "match") {
      continue;
    }
    if (!best || entry.timestamp > best.timestamp) {
      best = entry;
    }
  }
  return best;
}

export async function resolveIMessageCachedResourceBinding(
  messageId: string,
  ctx: IMessageChatContext & { accountId: string },
): Promise<"match" | "mismatch" | "unknown"> {
  await hydrateFromStoreOnce();
  return resolveCachedResourceBinding(messageId, ctx);
}

function resolveCachedResourceBinding(
  messageId: string,
  ctx: IMessageChatContext & { accountId: string },
): "match" | "mismatch" | "unknown" {
  const entry = imessageReplyCacheByMessageId.get(messageId.trim());
  if (!entry) {
    return "unknown";
  }
  if (Date.now() - entry.timestamp > IMESSAGE_REPLY_CACHE_TTL_MS) {
    return "unknown";
  }
  if (entry.accountId !== ctx.accountId) {
    return "mismatch";
  }
  return resolveIMessageChatMatch(entry, ctx);
}

type CurrentMessageChatParams = {
  accountId: string;
  currentMessageId: string | number;
  chatContext: IMessageChatContext;
};

/** @deprecated Used only by hosts without asynchronous conversation matching. */
export function isIMessageCurrentMessageInChat(params: CurrentMessageChatParams): boolean {
  hydrateFromStoreOnceSync();
  return isCurrentMessageInChat(params);
}

export async function isIMessageCurrentMessageInChatAsync(
  params: CurrentMessageChatParams,
): Promise<boolean> {
  await hydrateFromStoreOnce();
  return isCurrentMessageInChat(params);
}

function isCurrentMessageInChat(params: CurrentMessageChatParams): boolean {
  if (!params.accountId || !hasChatScope(params.chatContext)) {
    return false;
  }
  const currentMessageId = normalizeOptionalString(String(params.currentMessageId));
  if (!currentMessageId) {
    return false;
  }
  const fullMessageId = /^\d+$/.test(currentMessageId)
    ? imessageShortIdToUuid.get(currentMessageId)
    : currentMessageId;
  if (!fullMessageId) {
    return false;
  }
  return (
    resolveCachedResourceBinding(fullMessageId, {
      ...params.chatContext,
      accountId: params.accountId,
    }) === "match"
  );
}
