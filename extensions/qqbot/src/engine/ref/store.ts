/** Ref-index store backed by the plugin SQLite state table. */

import type { GatewayPluginRuntime } from "../gateway/types.js";
import { createMemoryKeyedStore, type KeyedStore } from "../state/keyed-store.js";
import { formatErrorMessage } from "../utils/format.js";
import { debugLog, debugError } from "../utils/log.js";
import type { RefIndexEntry } from "./types.js";

// Re-export types and format function for convenience.
export type { RefIndexEntry, RefAttachmentSummary } from "./types.js";
export { formatRefEntryForAgent } from "./format-ref-entry.js";

const MAX_ENTRIES = 50000;
const TTL_MS = 7 * 24 * 60 * 60 * 1000;
const REF_INDEX_NAMESPACE = "ref-index";

type StoredRefIndexEntry = RefIndexEntry & { createdAt: number };

let cache: Map<string, RefIndexEntry & { _createdAt: number }> | null = null;
let refIndexStore: KeyedStore<StoredRefIndexEntry> = createMemoryKeyedStore();

export async function configureRefIndexStore(runtime: GatewayPluginRuntime): Promise<void> {
  refIndexStore = runtime.state.openKeyedStore<StoredRefIndexEntry>({
    namespace: REF_INDEX_NAMESPACE,
    maxEntries: MAX_ENTRIES,
    defaultTtlMs: TTL_MS,
  });
  cache = null;
  await loadFromStore();
}

async function loadFromStore(): Promise<Map<string, RefIndexEntry & { _createdAt: number }>> {
  if (cache !== null) {
    return cache;
  }
  cache = new Map();

  try {
    const entries = await refIndexStore.entries();
    const now = Date.now();
    let expired = 0;

    for (const entry of entries) {
      const createdAt = entry.value.createdAt || entry.createdAt;
      if (now - createdAt > TTL_MS) {
        expired++;
        continue;
      }
      cache.set(entry.key, { ...entry.value, _createdAt: createdAt });
    }
    debugLog(`[ref-index-store] Loaded ${cache.size} entries (${expired} expired)`);
  } catch (err) {
    debugError(`[ref-index-store] Failed to load: ${formatErrorMessage(err)}`);
    cache = new Map();
  }
  return cache;
}

function loadFromStoreSync(): Map<string, RefIndexEntry & { _createdAt: number }> {
  if (cache === null) {
    cache = new Map();
  }
  return cache;
}

function evictIfNeeded(): void {
  if (!cache || cache.size < MAX_ENTRIES) {
    return;
  }
  const now = Date.now();
  for (const [key, entry] of cache) {
    if (now - entry._createdAt > TTL_MS) {
      cache.delete(key);
    }
  }
  if (cache.size >= MAX_ENTRIES) {
    const sorted = [...cache.entries()].toSorted((a, b) => a[1]._createdAt - b[1]._createdAt);
    const toRemove = sorted.slice(0, cache.size - MAX_ENTRIES + 1000);
    for (const [key] of toRemove) {
      cache.delete(key);
      void refIndexStore.delete(key);
    }
    debugLog(`[ref-index-store] Evicted ${toRemove.length} oldest entries`);
  }
}

/** Persist a refIdx mapping for one message. */
export function setRefIndex(refIdx: string, entry: RefIndexEntry): void {
  const store = loadFromStoreSync();
  evictIfNeeded();
  const now = Date.now();
  store.set(refIdx, { ...entry, _createdAt: now });
  void refIndexStore
    .register(
      refIdx,
      {
        content: entry.content,
        senderId: entry.senderId,
        senderName: entry.senderName,
        timestamp: entry.timestamp,
        isBot: entry.isBot,
        attachments: entry.attachments,
        createdAt: now,
      },
      { ttlMs: TTL_MS },
    )
    .catch((err: unknown) => {
      debugError(`[ref-index-store] Failed to save: ${formatErrorMessage(err)}`);
    });
}

/** Look up one quoted message by refIdx. */
export function getRefIndex(refIdx: string): RefIndexEntry | null {
  const store = loadFromStoreSync();
  const entry = store.get(refIdx);
  if (!entry) {
    return null;
  }
  if (Date.now() - entry._createdAt > TTL_MS) {
    store.delete(refIdx);
    void refIndexStore.delete(refIdx);
    return null;
  }
  return {
    content: entry.content,
    senderId: entry.senderId,
    senderName: entry.senderName,
    timestamp: entry.timestamp,
    isBot: entry.isBot,
    attachments: entry.attachments,
  };
}

/** Flush pending writes before process exit. Writes are registered eagerly. */
export function flushRefIndex(): void {}
