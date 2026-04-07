// ============================================================================
// Type definitions
// ============================================================================

/** Single reqId record */
interface ReqIdEntry {
  /** Request ID */
  reqId: string;
  /** Record timestamp (milliseconds) */
  ts: number;
}

/** Store configuration */
interface ReqIdStoreOptions {
  /** TTL in milliseconds, expired reqIds are considered stale (default 7 days) */
  ttlMs?: number;
  /** Maximum in-memory entries (default 200) */
  memoryMaxSize?: number;
}

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const DEFAULT_MEMORY_MAX_SIZE = 200;

// ============================================================================
// Public interface
// ============================================================================

export interface PersistentReqIdStore {
  /** Set the reqId for a chatId (writes to memory only) */
  set(chatId: string, reqId: string): void;
  /** Get the reqId for a chatId (memory only) */
  get(chatId: string): Promise<string | undefined>;
  /** Synchronously get the reqId for a chatId (memory only) */
  getSync(chatId: string): string | undefined;
  /** Delete the reqId for a chatId */
  delete(chatId: string): void;
  /** Clear the in-memory cache */
  clearMemory(): void;
  /** Return the number of entries in memory */
  memorySize(): number;
}

// ============================================================================
// Core implementation
// ============================================================================

export function createPersistentReqIdStore(
  accountId: string,
  options?: ReqIdStoreOptions,
): PersistentReqIdStore {
  const ttlMs = options?.ttlMs ?? DEFAULT_TTL_MS;
  const memoryMaxSize = options?.memoryMaxSize ?? DEFAULT_MEMORY_MAX_SIZE;

  // Memory layer: chatId → ReqIdEntry
  const memory = new Map<string, ReqIdEntry>();

  // ========== Internal helper functions ==========

  /** Check if an entry is expired */
  function isExpired(entry: ReqIdEntry, now: number): boolean {
    return ttlMs > 0 && now - entry.ts >= ttlMs;
  }

  /**
   * Memory capacity control: evict the oldest entries.
   * Uses Map insertion order + touch (delete then set) for LRU-like behavior.
   */
  function pruneMemory(): void {
    if (memory.size <= memoryMaxSize) {
      return;
    }
    const sorted = [...memory.entries()].toSorted((a, b) => a[1].ts - b[1].ts);
    const toRemove = sorted.slice(0, memory.size - memoryMaxSize);
    for (const [key] of toRemove) {
      memory.delete(key);
    }
  }

  // ========== Public API ==========

  function set(chatId: string, reqId: string): void {
    const entry: ReqIdEntry = { reqId, ts: Date.now() };
    // touch: delete then set to maintain Map insertion order (LRU-like)
    memory.delete(chatId);
    memory.set(chatId, entry);
    pruneMemory();
  }

  async function get(chatId: string): Promise<string | undefined> {
    const now = Date.now();

    // Check memory only
    const memEntry = memory.get(chatId);
    if (memEntry && !isExpired(memEntry, now)) {
      return memEntry.reqId;
    }
    if (memEntry) {
      memory.delete(chatId); // Delete if expired
    }

    return undefined;
  }

  function getSync(chatId: string): string | undefined {
    const now = Date.now();
    const entry = memory.get(chatId);
    if (entry && !isExpired(entry, now)) {
      return entry.reqId;
    }
    if (entry) {
      memory.delete(chatId);
    }
    return undefined;
  }

  function del(chatId: string): void {
    memory.delete(chatId);
  }

  function clearMemory(): void {
    memory.clear();
  }

  function memorySize(): number {
    return memory.size;
  }

  return {
    set,
    get,
    getSync,
    delete: del,
    clearMemory,
    memorySize,
  };
}
