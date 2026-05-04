/**
 * Bounded LRU + TTL dedup cache for the MAX polling supervisor (per
 * docs/max-plugin/plan.md §6.1.6 / §8 row 16 / §9 N3).
 *
 * Closes the gap created by bypassing `bot.start()`: when the supervisor
 * restarts after a crash or a network blip, MAX may replay a recently-acked
 * batch (the SDK persists no marker; the loop persists one but commits it
 * after dispatch, so any window between dispatch and marker write is
 * recoverable via dedup). Same-mid replay is silently dropped here.
 *
 * Key shape:
 *   - `msg:<message.body.mid>` for `message_*` updates
 *   - `cb:<callback.callback_id>` for `message_callback`
 *
 * If neither id is present (membership events, chat title change, etc.) the
 * caller logs `dedup_key_missing` and processes the update unconditionally —
 * better duplicate than silent drop.
 *
 * Defaults are §8 row 16: capacity 10000, TTL 1 hour. Both are configurable
 * for tests and for environments that want tighter or looser memory pressure.
 */

const DEFAULT_CAPACITY = 10_000;
const DEFAULT_TTL_MS = 3_600_000; // 1h

export type DedupCache = {
  /** Returns true if `key` has been seen recently (within TTL and not evicted). */
  has(key: string): boolean;
  /**
   * Record `key` as seen. Refreshes its insertion order so it becomes the
   * newest entry — useful when the same mid is dispatched intentionally as
   * part of an edited-message echo and we don't want it evicted prematurely.
   */
  add(key: string): void;
  /** Active entry count (after evicting expired entries). */
  size(): number;
  /** Drop all entries (used by `gateway.logoutAccount`). */
  clear(): void;
};

export type DedupCacheOptions = {
  capacity?: number;
  ttlMs?: number;
  /** Test seam — defaults to `Date.now`. */
  now?: () => number;
};

export function createDedupCache(opts: DedupCacheOptions = {}): DedupCache {
  const capacity = opts.capacity ?? DEFAULT_CAPACITY;
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  const now = opts.now ?? (() => Date.now());

  if (capacity < 1) {
    throw new Error(`dedup-cache: capacity must be >= 1 (got ${capacity}).`);
  }
  if (ttlMs < 1) {
    throw new Error(`dedup-cache: ttlMs must be >= 1 (got ${ttlMs}).`);
  }

  // Map preserves insertion order, so iteration walks oldest-first. Values are
  // the millisecond timestamp when the key was added; this lets us evict
  // expired entries lazily on every read without a separate timer.
  const entries = new Map<string, number>();

  const cutoff = (): number => now() - ttlMs;

  function evictExpired(): void {
    const limit = cutoff();
    for (const [key, addedAt] of entries) {
      if (addedAt > limit) {
        // Map iteration is insertion-ordered, so once we see a non-expired
        // entry every later entry is also non-expired.
        return;
      }
      entries.delete(key);
    }
  }

  function evictOverCapacity(): void {
    while (entries.size > capacity) {
      const oldestKey = entries.keys().next().value;
      if (oldestKey === undefined) {
        return;
      }
      entries.delete(oldestKey);
    }
  }

  return {
    has(key) {
      evictExpired();
      const ts = entries.get(key);
      if (ts === undefined) {
        return false;
      }
      // `has` is a read — do not refresh insertion order. `add` handles
      // freshness explicitly when a duplicate is intentionally re-recorded.
      return ts > cutoff();
    },
    add(key) {
      evictExpired();
      // Re-insert to bump to newest insertion-order position, then evict
      // until we're back under capacity. This keeps the eviction policy
      // a true LRU (oldest-by-insertion drops first when full).
      entries.delete(key);
      entries.set(key, now());
      evictOverCapacity();
    },
    size() {
      evictExpired();
      return entries.size;
    },
    clear() {
      entries.clear();
    },
  };
}
