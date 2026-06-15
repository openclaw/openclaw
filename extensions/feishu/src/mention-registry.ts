/**
 * Per-chat mention registry: accumulates name → openId mappings from inbound
 * messages so the outbound normalizer (L2) can resolve `@Name` to a proper
 * `<at user_id="ou_xxx">Name</at>` tag.
 *
 * Data sources:
 *   R1 — inbound message mentions[] (highest precision)
 *   R4 — inbound message sender (covers people who spoke but were never @-ed)
 */

const ENTRY_TTL_MS = 30 * 60 * 1000; // 30 min
const MAX_ENTRIES_PER_CHAT = 200;
const MAX_CHATS = 500;

export type RegistrySource = "mention" | "sender";

export type RegistryEntry = {
  name: string;
  openId: string;
  source: RegistrySource;
  updatedAt: number;
};

type ChatRegistry = Map<string, RegistryEntry>; // lowercase name → entry

// Keyed by `${accountId}:${chatId}` so multi-account gateways don't collide.
const store = new Map<string, ChatRegistry>();

function chatKey(accountId: string, chatId: string): string {
  return `${accountId}:${chatId}`;
}

function getOrCreateChat(accountId: string, chatId: string): ChatRegistry {
  const key = chatKey(accountId, chatId);
  let chat = store.get(key);
  if (chat) {
    // Refresh LRU position for chat-level eviction.
    store.delete(key);
    store.set(key, chat);
    return chat;
  }
  // Evict oldest chat if at capacity.
  if (store.size >= MAX_CHATS) {
    const oldest = store.keys().next().value;
    if (oldest !== undefined) {
      store.delete(oldest);
    }
  }
  chat = new Map();
  store.set(key, chat);
  return chat;
}

function upsert(chat: ChatRegistry, name: string, openId: string, source: RegistrySource): void {
  const normalized = name.trim().toLowerCase();
  if (!normalized || !openId.trim()) {
    return;
  }
  const existing = chat.get(normalized);
  // R1 (mention) is more precise than R4 (sender); never downgrade.
  if (existing && existing.source === "mention" && source === "sender") {
    existing.updatedAt = Date.now();
    return;
  }
  // Refresh LRU position via delete + set.
  chat.delete(normalized);
  chat.set(normalized, { name: name.trim(), openId: openId.trim(), source, updatedAt: Date.now() });
  // Evict oldest if over capacity.
  while (chat.size > MAX_ENTRIES_PER_CHAT) {
    const oldest = chat.keys().next().value;
    if (oldest !== undefined) {
      chat.delete(oldest);
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** R1: record a mention from an inbound message's mentions[] array. */
export function recordMention(params: {
  accountId: string;
  chatId: string;
  name: string;
  openId: string;
}): void {
  const chat = getOrCreateChat(params.accountId, params.chatId);
  upsert(chat, params.name, params.openId, "mention");
}

/** R4: record the sender of an inbound message. */
export function recordSender(params: {
  accountId: string;
  chatId: string;
  name: string;
  openId: string;
}): void {
  const chat = getOrCreateChat(params.accountId, params.chatId);
  upsert(chat, params.name, params.openId, "sender");
}

/** Look up a name in the registry. Returns the openId or undefined. */
export function lookupMention(params: {
  accountId: string;
  chatId: string;
  name: string;
}): RegistryEntry | undefined {
  const key = chatKey(params.accountId, params.chatId);
  const chat = store.get(key);
  if (!chat) {
    return undefined;
  }
  const normalized = params.name.trim().toLowerCase();
  const entry = chat.get(normalized);
  if (!entry) {
    // Fuzzy fallback: try stripping whitespace/special chars
    const strippedNormalized = normalized.replace(/\s+/g, "");
    for (const [k, v] of chat) {
      if (k.replace(/\s+/g, "") === strippedNormalized) {
        if (v.updatedAt + ENTRY_TTL_MS > Date.now()) {
          return v;
        }
        // Clean up expired entry on the way out.
        chat.delete(k);
      }
    }
    return undefined;
  }
  if (entry.updatedAt + ENTRY_TTL_MS < Date.now()) {
    chat.delete(normalized);
    return undefined;
  }
  return entry;
}

/** List all known names for a chat (for L3 side-channel feedback). */
export function listKnownNames(params: { accountId: string; chatId: string }): string[] {
  const key = chatKey(params.accountId, params.chatId);
  const chat = store.get(key);
  if (!chat) {
    return [];
  }
  const now = Date.now();
  const names: string[] = [];
  for (const [k, entry] of chat) {
    if (entry.updatedAt + ENTRY_TTL_MS < now) {
      chat.delete(k);
      continue;
    }
    names.push(entry.name);
  }
  return names;
}

/** Reset for tests. */
export function resetMentionRegistryForTests(): void {
  store.clear();
}
