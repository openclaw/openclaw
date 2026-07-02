// Memory Lancedb helper module implements the per-instance Query Embedding
// Recall Cache.
//
// NOTE ON NAMING: this is NOT the host's "Memory Search Embedding Cache"
// (`agents.defaults.memorySearch.cache`), which caches CHUNK embeddings in
// SQLite at index time inside memory-core. This cache lives in memory-lancedb,
// is an in-memory LRU of QUERY (recall) embeddings, and operates at recall time.
// Different layer, different cost, different lifecycle.
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

import { createHash } from "node:crypto";

export const QUERY_EMBED_CACHE_MAX_ENTRIES = 512;

/**
 * Build a cache key whose components are both hashed, so the in-memory cache
 * never retains raw recall/store/auto-capture text NOR raw provider identity as
 * a Map key. The text is digested here; the `identity` argument is already a
 * digest produced by {@link canonicalizeEmbeddingIdentity}. SHA-256 preserves
 * equality (identical identity + text map to the same key) while keeping only
 * fixed-length digests in process memory, not plaintext user/memory content and
 * not provider-owned identity material (which may carry secret-shaped fields
 * such as authorization headers inside `cacheKeyData`).
 */
export function queryCacheKey(identity: string, text: string): string {
  const textDigest = createHash("sha256").update(text, "utf8").digest("hex");
  return JSON.stringify([identity, textDigest]);
}

/**
 * Build the canonical identity portion of a cache key as a SHA-256 digest. The
 * identity MUST encode everything that changes the produced vector — provider,
 * model, dimensions, endpoint — so that switching model/provider/dims can never
 * return a stale or wrong-dimension embedding from the cache. `cacheKeyData`
 * (when the adapter supplies it) already captures
 * provider/baseUrl/model/outputDimensionality, so it is preferred; otherwise we
 * fall back to the configured provider/model/dims.
 *
 * SECURITY: `cacheKeyData` is a provider-owned `Record<string, unknown>` and may
 * contain secret-shaped material (e.g. `headers.authorization`). We therefore
 * hash the canonical serialization rather than retaining it verbatim, mirroring
 * the memory-core provider-identity path (`hashText(JSON.stringify(...))`).
 * Distinct identities still map to distinct digests, so model/provider/dims
 * separation is preserved without keeping plaintext identity in heap keys.
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
  return createHash("sha256").update(JSON.stringify(sorted), "utf8").digest("hex");
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
 * Dependency-free, bounded LRU over an embeddings instance. Settled entries are
 * keyed by `[identity, normalizedText]`; in-flight work is keyed separately so
 * concurrent callers only share a provider call when their cancellation policy
 * matches. This avoids coupling a timeout-bound recall to an untimed store or
 * capture call for the same text, while still sharing the settled vector after
 * either request succeeds.
 *
 * A Map preserves insertion order: a cache hit deletes+re-inserts the key to
 * bump recency, and overflow evicts the oldest (first) settled key.
 */
export class QueryEmbeddingCache {
  private readonly entries = new Map<string, number[]>();
  private readonly pending = new Map<string, Promise<number[]>>();
  private readonly maxEntries: number;
  private readonly enabled: boolean;

  constructor(options?: { maxEntries?: number; enabled?: boolean }) {
    this.maxEntries = options?.maxEntries ?? QUERY_EMBED_CACHE_MAX_ENTRIES;
    this.enabled = options?.enabled ?? true;
  }

  async getOrCompute(
    key: string,
    compute: () => Promise<number[]>,
    options?: { inFlightKey?: string },
  ): Promise<number[]> {
    // When disabled, behave as a pass-through: never store, always recompute, so
    // the embed() call sites stay identical regardless of configuration.
    if (!this.enabled) {
      return compute();
    }
    const existing = this.entries.get(key);
    if (existing) {
      // Bump recency: delete + re-set moves the key to the most-recent slot.
      this.entries.delete(key);
      this.entries.set(key, existing);
      return existing;
    }
    const inFlightKey = options?.inFlightKey ?? key;
    const existingPending = this.pending.get(inFlightKey);
    if (existingPending) {
      return existingPending;
    }
    const pending = compute();
    this.pending.set(inFlightKey, pending);
    // Only settled, genuine vectors enter the LRU. Failed/degenerate results
    // are not memoized, so a transient failure is never cached and the next call
    // retries the provider.
    pending
      .then((vector) => {
        if (this.pending.get(inFlightKey) === pending) {
          this.pending.delete(inFlightKey);
        }
        if (isCacheableEmbeddingVector(vector)) {
          this.entries.delete(key);
          this.entries.set(key, vector);
          if (this.entries.size > this.maxEntries) {
            const oldest = this.entries.keys().next().value;
            if (oldest !== undefined) {
              this.entries.delete(oldest);
            }
          }
        }
      })
      .catch(() => {
        if (this.pending.get(inFlightKey) === pending) {
          this.pending.delete(inFlightKey);
        }
      });
    return pending;
  }
}
