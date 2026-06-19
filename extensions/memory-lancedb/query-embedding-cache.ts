// Memory Lancedb helper module implements per-instance query-embedding caching.
//
// The query-embedding round-trip dominates the LanceDB vector scan (a remote
// embed is ~50-300ms vs a few ms for a flat scan over a typical store), and a
// single user turn can embed the same recall query up to three times (the
// memory_recall tool, the auto-recall hook, and capture/dedup) with no caching.
// An in-instance bounded cache collapses those identical embeds to one provider
// call. (model, text) -> embedding is deterministic, so eviction is purely by
// capacity; there is NO TTL because a cached vector can never go stale for a
// fixed identity, and the cache is per-instance so a reconfigure (which builds a
// fresh embeddings instance) starts with a clean cache keyed to the new model.

export const QUERY_EMBED_CACHE_MAX_ENTRIES = 512;

/**
 * Build the canonical identity portion of a cache key. The identity MUST encode
 * everything that changes the produced vector — provider, model, dimensions,
 * endpoint — so that switching model/provider/dims can never return a stale or
 * wrong-dimension embedding from the cache. `cacheKeyData` (when the adapter
 * supplies it) already captures provider/baseUrl/model/outputDimensionality, so
 * it is preferred; otherwise we fall back to the configured provider/model/dims.
 */
export function canonicalizeEmbeddingIdentity(identity: Record<string, unknown>): string {
  // Stable serialization: sort top-level keys so field order never changes the
  // string. Rebuild via fromEntries rather than passing a replacer array to
  // JSON.stringify — a replacer array also filters NESTED objects (e.g. it would
  // erase cacheKeyData.headers), which would let two distinct identities collide.
  const sorted = Object.fromEntries(
    Object.keys(identity)
      .toSorted()
      .map((key) => [key, identity[key]]),
  );
  return JSON.stringify(sorted);
}

export function isCacheableEmbeddingVector(vector: number[]): boolean {
  // Only memoize a genuine result: a non-empty, all-finite, non-zero vector.
  // An empty/zero vector or NaN/Infinity signals a failed or degenerate embed
  // and must NOT be cached, so a transient failure is never memoized.
  return (
    vector.length > 0 &&
    vector.every((value) => Number.isFinite(value)) &&
    vector.some((value) => value !== 0)
  );
}

/**
 * Dependency-free, bounded LRU over an embeddings instance. Keys are
 * `[identity, normalizedText]`; values are the in-flight embed promise so that
 * both sequential and concurrent identical embeds collapse to one provider call.
 * A Map preserves insertion order: a cache hit deletes+re-inserts the key to
 * bump recency, and overflow evicts the oldest (first) key.
 */
export class QueryEmbeddingCache {
  private readonly entries = new Map<string, Promise<number[]>>();

  constructor(private readonly maxEntries = QUERY_EMBED_CACHE_MAX_ENTRIES) {}

  async getOrCompute(key: string, compute: () => Promise<number[]>): Promise<number[]> {
    const existing = this.entries.get(key);
    if (existing) {
      // Bump recency: delete + re-set moves the key to the most-recent slot.
      this.entries.delete(key);
      this.entries.set(key, existing);
      return existing;
    }
    const pending = compute();
    this.entries.set(key, pending);
    // Evict failed/degenerate results so a transient failure is never memoized
    // and the next call retries the provider.
    pending
      .then((vector) => {
        if (!isCacheableEmbeddingVector(vector) && this.entries.get(key) === pending) {
          this.entries.delete(key);
        }
      })
      .catch(() => {
        if (this.entries.get(key) === pending) {
          this.entries.delete(key);
        }
      });
    if (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) {
        this.entries.delete(oldest);
      }
    }
    return pending;
  }
}
