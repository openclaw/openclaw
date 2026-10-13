// WhatsApp poll records and the per-chat poll index, persisted in plugin state.
import { jidNormalizedUser } from "baileys";
import type {
  OpenKeyedStoreOptions,
  PluginStateKeyedStore,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { getOptionalWhatsAppRuntime } from "./runtime.js";

export type WhatsAppPollOrigin = "sent" | "received";

export type WhatsAppPollRecord = {
  v: 1;
  origin: WhatsAppPollOrigin;
  chatJids: string[];
  creatorJids: string[];
  creatorName?: string;
  question: string;
  /** Base64 of the 32-byte poll message secret. */
  secret: string;
  options: string[];
  selectableCount: number;
  recordedAt: number;
};

export type WhatsAppPollRecordInput = {
  accountId: string;
  pollMessageId: string;
  origin: WhatsAppPollOrigin;
  chatJids: readonly (string | null | undefined)[];
  creatorJids: readonly (string | null | undefined)[];
  creatorName?: string;
  question: string;
  secret: Uint8Array;
  options: string[];
  selectableCount: number;
  recordedAt?: number;
};

export type WhatsAppChatPollIndexEntry = {
  pollMessageId: string;
  origin: WhatsAppPollOrigin;
  recordedAt: number;
};

type WhatsAppPollChatIndexValue = {
  v: 1;
  pollMessageId: string;
  origin: WhatsAppPollOrigin;
};

/** "throw" surfaces every store failure to the caller, which then owns the warning. */
export type WhatsAppPollStoreErrorMode = "classify" | "throw";

export const WHATSAPP_POLL_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MIN_TTL_MS = 60_000;
const POLL_MESSAGE_ID_MAX_BYTES = 128;
const STORE_KEY_MAX_BYTES = 512;
const QUESTION_MAX_BYTES = 1024;
const NAME_MAX_BYTES = 128;
const MAX_CHAT_JIDS = 4;

export const WHATSAPP_POLL_RECORD_STORES: Record<WhatsAppPollOrigin, OpenKeyedStoreOptions> = {
  sent: { namespace: "whatsapp.poll-sent", maxEntries: 2000, defaultTtlMs: WHATSAPP_POLL_TTL_MS },
  received: {
    namespace: "whatsapp.poll-received",
    maxEntries: 2000,
    defaultTtlMs: WHATSAPP_POLL_TTL_MS,
  },
};
// Split by origin so a flood of incoming polls cannot evict the index rows of the agent's polls.
export const WHATSAPP_POLL_CHAT_INDEX_STORES: Record<WhatsAppPollOrigin, OpenKeyedStoreOptions> = {
  sent: {
    namespace: "whatsapp.poll-chat-sent",
    maxEntries: 8000,
    defaultTtlMs: WHATSAPP_POLL_TTL_MS,
  },
  received: {
    namespace: "whatsapp.poll-chat-received",
    maxEntries: 8000,
    defaultTtlMs: WHATSAPP_POLL_TTL_MS,
  },
};

// Only storage-availability failures are worth replaying; everything else is permanent.
const TRANSIENT_READ_CODES = new Set([
  "PLUGIN_STATE_READ_FAILED",
  "PLUGIN_STATE_OPEN_FAILED",
  "PLUGIN_STATE_SQLITE_UNAVAILABLE",
]);
const TRANSIENT_WRITE_CODES = new Set([...TRANSIENT_READ_CODES, "PLUGIN_STATE_WRITE_FAILED"]);

const textEncoder = new TextEncoder();

export function utf8ByteLength(value: string): number {
  return textEncoder.encode(value).byteLength;
}

/** Cuts at a code point boundary so the result never ends in half a character. */
export function truncateUtf8(value: string, maxBytes: number): string {
  if (utf8ByteLength(value) <= maxBytes) {
    return value;
  }
  let bytes = 0;
  let end = 0;
  for (const char of value) {
    const size = utf8ByteLength(char);
    if (bytes + size > maxBytes) {
      break;
    }
    bytes += size;
    end += char.length;
  }
  return value.slice(0, end);
}

export function readPluginStateErrorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return typeof code === "string" ? code : undefined;
}

export function isTransientWhatsAppPollStoreError(
  error: unknown,
  kind: "read" | "write" = "read",
): boolean {
  const code = readPluginStateErrorCode(error);
  return (
    code !== undefined &&
    (kind === "write" ? TRANSIENT_WRITE_CODES : TRANSIENT_READ_CODES).has(code)
  );
}

export function warnWhatsAppPollState(message: string, fields: Record<string, unknown>): void {
  try {
    getOptionalWhatsAppRuntime()
      ?.logging.getChildLogger({ plugin: "whatsapp", feature: "poll-votes" })
      .warn(message, fields);
  } catch {
    // Logging must never change poll handling.
  }
}

/**
 * Transient failures are rethrown so durable ingress replays the event; anything
 * else is logged once (code only, never content) and resolved to the fallback.
 */
export async function runWhatsAppPollStoreOperation<T>(params: {
  operation: string;
  fallback: T;
  errors?: WhatsAppPollStoreErrorMode;
  transient?: "read" | "write" | "none";
  run: () => Promise<T>;
}): Promise<T> {
  try {
    return await params.run();
  } catch (error) {
    const transient = params.transient ?? "read";
    if (
      params.errors === "throw" ||
      (transient !== "none" && isTransientWhatsAppPollStoreError(error, transient))
    ) {
      throw error;
    }
    warnWhatsAppPollState(`whatsapp poll store ${params.operation} failed`, {
      code: readPluginStateErrorCode(error) ?? "unknown",
    });
    return params.fallback;
  }
}

export function openWhatsAppPollStore<T>(
  options: OpenKeyedStoreOptions,
): PluginStateKeyedStore<T> | undefined {
  const runtime = getOptionalWhatsAppRuntime();
  if (typeof runtime?.state?.openKeyedStore !== "function") {
    return undefined;
  }
  return runtime.state.openKeyedStore<T>(options);
}

/** Bounds untrusted poll ids before they can reach storage keys. */
export function normalizeWhatsAppPollMessageId(
  value: string | null | undefined,
): string | undefined {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed || utf8ByteLength(trimmed) > POLL_MESSAGE_ID_MAX_BYTES) {
    logVerbose("whatsapp poll id rejected: empty or longer than 128 bytes");
    return undefined;
  }
  return trimmed;
}

/** Device suffixes differ per client; storage and comparisons use the bare user JID. */
export function normalizeWhatsAppPollJid(value: string | null | undefined): string | undefined {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed) {
    return undefined;
  }
  try {
    return jidNormalizedUser(trimmed) || trimmed;
  } catch {
    return trimmed;
  }
}

export function normalizeWhatsAppPollJids(
  values: readonly (string | null | undefined)[],
): string[] {
  const result: string[] = [];
  for (const value of values) {
    const jid = normalizeWhatsAppPollJid(value);
    if (jid && !result.includes(jid)) {
      result.push(jid);
    }
  }
  return result;
}

export function resolveWhatsAppPollTtlMs(recordedAt: number, now = Date.now()): number {
  return Math.max(MIN_TTL_MS, recordedAt + WHATSAPP_POLL_TTL_MS - now);
}

export function buildWhatsAppKeyPrefixRange(prefix: string, limit: number) {
  // Every prefix ends in ":", so the next code unit bounds exactly that prefix.
  return {
    keyStartInclusive: prefix,
    keyEndExclusive: `${prefix.slice(0, -1)};`,
    limit,
  };
}

function buildRecordKey(accountId: string, pollMessageId: string): string {
  return `${accountId}:${pollMessageId}`;
}

function buildChatIndexPrefix(accountId: string, chatJid: string): string {
  return `${accountId}:${chatJid}:`;
}

function isPollRecord(value: unknown): value is WhatsAppPollRecord {
  const record = value as Partial<WhatsAppPollRecord> | null | undefined;
  return (
    record?.v === 1 &&
    (record.origin === "sent" || record.origin === "received") &&
    Array.isArray(record.chatJids) &&
    Array.isArray(record.creatorJids) &&
    typeof record.question === "string" &&
    typeof record.secret === "string" &&
    Array.isArray(record.options) &&
    record.options.every((option) => typeof option === "string") &&
    typeof record.selectableCount === "number" &&
    typeof record.recordedAt === "number"
  );
}

export async function recordWhatsAppPoll(
  input: WhatsAppPollRecordInput,
  opts: { mode: "overwrite" | "ifAbsent" },
): Promise<boolean> {
  const pollMessageId = normalizeWhatsAppPollMessageId(input.pollMessageId);
  const accountId = input.accountId.trim();
  if (!pollMessageId || !accountId) {
    return false;
  }
  const recordedAt = input.recordedAt ?? Date.now();
  const chatJids = normalizeWhatsAppPollJids(input.chatJids).slice(0, MAX_CHAT_JIDS);
  const record: WhatsAppPollRecord = {
    v: 1,
    origin: input.origin,
    chatJids,
    creatorJids: normalizeWhatsAppPollJids(input.creatorJids),
    ...(input.creatorName?.trim()
      ? { creatorName: truncateUtf8(input.creatorName.trim(), NAME_MAX_BYTES) }
      : {}),
    question: truncateUtf8(input.question, QUESTION_MAX_BYTES),
    secret: Buffer.from(input.secret).toString("base64"),
    options: [...input.options],
    selectableCount: input.selectableCount,
    recordedAt,
  };
  const ttlMs = resolveWhatsAppPollTtlMs(recordedAt);
  const written = await runWhatsAppPollStoreOperation({
    operation: "record",
    fallback: false,
    transient: "none",
    run: async () => {
      const recordStore = openWhatsAppPollStore<WhatsAppPollRecord>(
        WHATSAPP_POLL_RECORD_STORES[input.origin],
      );
      if (!recordStore) {
        return false;
      }
      const key = buildRecordKey(accountId, pollMessageId);
      if (opts.mode === "ifAbsent") {
        return await recordStore.registerIfAbsent(key, record, { ttlMs });
      }
      await recordStore.register(key, record, { ttlMs });
      return true;
    },
  });
  if (!written) {
    return false;
  }
  const stamp = String(recordedAt).padStart(13, "0");
  const indexKeys = chatJids
    .map((chatJid) => `${buildChatIndexPrefix(accountId, chatJid)}${stamp}:${pollMessageId}`)
    .filter((key) => {
      if (utf8ByteLength(key) <= STORE_KEY_MAX_BYTES) {
        return true;
      }
      logVerbose("whatsapp poll chat index key exceeds 512 bytes; poll will not appear in results");
      return false;
    });
  await runWhatsAppPollStoreOperation({
    operation: "index",
    fallback: undefined,
    transient: "none",
    run: async () => {
      const indexStore = openWhatsAppPollStore<WhatsAppPollChatIndexValue>(
        WHATSAPP_POLL_CHAT_INDEX_STORES[input.origin],
      );
      for (const key of indexKeys) {
        await indexStore?.register(key, { v: 1, pollMessageId, origin: input.origin }, { ttlMs });
      }
    },
  });
  return true;
}

/** Looks in the agent's own polls first, then in recorded incoming polls. */
export async function readWhatsAppPollRecord(
  accountIdInput: string,
  pollMessageIdInput: string | null | undefined,
  opts?: { errors?: WhatsAppPollStoreErrorMode },
): Promise<WhatsAppPollRecord | undefined> {
  const pollMessageId = normalizeWhatsAppPollMessageId(pollMessageIdInput);
  const accountId = accountIdInput.trim();
  if (!pollMessageId || !accountId) {
    return undefined;
  }
  return await runWhatsAppPollStoreOperation({
    operation: "read",
    fallback: undefined,
    errors: opts?.errors,
    run: async () => {
      for (const origin of ["sent", "received"] as const) {
        const store = openWhatsAppPollStore<WhatsAppPollRecord>(
          WHATSAPP_POLL_RECORD_STORES[origin],
        );
        const value = await store?.lookup(buildRecordKey(accountId, pollMessageId));
        if (value !== undefined) {
          return isPollRecord(value) ? value : undefined;
        }
      }
      return undefined;
    },
  });
}

/** Newest first, merged across both origins; ids may outlive their record and must be re-read. */
export async function listWhatsAppChatPollIds(params: {
  accountId: string;
  chatJids: readonly (string | null | undefined)[];
  limit: number;
  errors?: WhatsAppPollStoreErrorMode;
}): Promise<WhatsAppChatPollIndexEntry[]> {
  const accountId = params.accountId.trim();
  const chatJids = normalizeWhatsAppPollJids(params.chatJids);
  if (!accountId || chatJids.length === 0 || params.limit < 1) {
    return [];
  }
  return await runWhatsAppPollStoreOperation({
    operation: "list",
    fallback: [],
    errors: params.errors,
    run: async () => {
      const found = new Map<string, WhatsAppChatPollIndexEntry>();
      for (const origin of ["sent", "received"] as const) {
        const store = openWhatsAppPollStore<WhatsAppPollChatIndexValue>(
          WHATSAPP_POLL_CHAT_INDEX_STORES[origin],
        );
        if (typeof store?.entriesInKeyRange !== "function") {
          continue;
        }
        for (const chatJid of chatJids) {
          const prefix = buildChatIndexPrefix(accountId, chatJid);
          const rows = await store.entriesInKeyRange({
            ...buildWhatsAppKeyPrefixRange(prefix, params.limit),
            order: "desc",
          });
          for (const row of rows) {
            const stamp = row.key.slice(prefix.length).split(":", 1)[0] ?? "";
            const recordedAt = Number(stamp);
            const pollMessageId = row.value?.pollMessageId;
            if (
              row.value?.v !== 1 ||
              typeof pollMessageId !== "string" ||
              !Number.isFinite(recordedAt) ||
              found.has(pollMessageId)
            ) {
              continue;
            }
            found.set(pollMessageId, { pollMessageId, origin, recordedAt });
          }
        }
      }
      return [...found.values()]
        .toSorted((a, b) => b.recordedAt - a.recordedAt)
        .slice(0, params.limit);
    },
  });
}
