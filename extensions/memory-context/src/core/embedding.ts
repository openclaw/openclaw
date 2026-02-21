import type { OpenClawConfig } from "../../../../src/config/config.js";
import {
  createEmbeddingProvider as createUnifiedEmbeddingProvider,
  type EmbeddingProvider as UnifiedEmbeddingProvider,
  type EmbeddingProviderRequest,
  type EmbeddingProviderResult,
} from "../../../../src/memory/embeddings.js";

/**
 * memory-context embedding provider interface.
 *
 * Wraps the unified embedding system (src/memory/embeddings.ts) via adapter.
 * Both memory-search and memory-context share the same provider infrastructure.
 */
export type EmbeddingProvider = {
  /** Embedding dimension. 0 = noop (BM25-only). */
  dim: number;
  embed(text: string): Promise<number[]>;
  init?(): Promise<void>;
  /** Provider name for logging. */
  readonly name?: string;
};

// ---- LRU Embedding Cache ----

/**
 * Simple LRU cache for query embeddings.
 * Avoids redundant API calls for repeated or similar queries.
 */
class EmbeddingCache {
  private readonly cache = new Map<string, number[]>();
  constructor(private readonly maxSize: number = 128) {}

  get(key: string): number[] | undefined {
    const v = this.cache.get(key);
    if (v !== undefined) {
      // Move to end (most recently used)
      this.cache.delete(key);
      this.cache.set(key, v);
    }
    return v;
  }

  set(key: string, value: number[]): void {
    if (this.cache.has(key)) {
      this.cache.delete(key);
    } else if (this.cache.size >= this.maxSize) {
      // Evict LRU (first entry)
      const first = this.cache.keys().next().value;
      if (first !== undefined) {
        this.cache.delete(first);
      }
    }
    this.cache.set(key, value);
  }

  get size(): number {
    return this.cache.size;
  }

  clear(): void {
    this.cache.clear();
  }
}

/**
 * Wrap an EmbeddingProvider with an LRU cache.
 * Cache key is the raw text (normalized to trim whitespace).
 */
export function withEmbeddingCache(provider: EmbeddingProvider, maxSize = 128): EmbeddingProvider {
  const cache = new EmbeddingCache(maxSize);

  return {
    get dim() {
      return provider.dim;
    },
    get name() {
      return provider.name;
    },
    async embed(text: string): Promise<number[]> {
      const key = text.trim();
      const cached = cache.get(key);
      if (cached) {
        return cached;
      }
      const vec = await provider.embed(text);
      if (vec.length > 0) {
        cache.set(key, vec);
      }
      return vec;
    },
    async init(): Promise<void> {
      await provider.init?.();
    },
  };
}

/**
 * Adapter: wrap a unified EmbeddingProvider (memory-search interface) into
 * the memory-context EmbeddingProvider interface ({ dim, embed }).
 *
 * Detects dim by probing the provider once on first embed call.
 * For noop providers (id="none"), returns dim=0 and empty vectors
 * so the store correctly falls back to BM25-only search.
 */
function wrapUnifiedProvider(
  provider: UnifiedEmbeddingProvider,
  logger?: { warn: (msg: string) => void; info?: (msg: string) => void },
): EmbeddingProvider {
  // Noop provider (all remote+local+transformer failed → BM25 only)
  if (provider.id === "none") {
    logger?.info?.("[memory-context] embedding: noop (BM25-only, no vector search)");
    return {
      // Use dim=1 so VectorIndex constructor doesn't throw (requires dim > 0).
      // All vectors are zero → cosine similarity = 0 → BM25 dominates ranking.
      dim: 1,
      name: "none",
      async embed() {
        return [0];
      },
    };
  }

  let cachedDim = 0;
  let dimDetected = false;

  return {
    get dim() {
      return cachedDim;
    },
    name: provider.id,
    async embed(text: string): Promise<number[]> {
      const vec = await provider.embedQuery(text);
      if (!dimDetected && vec.length > 0) {
        cachedDim = vec.length;
        dimDetected = true;
      }
      return vec;
    },
    async init(): Promise<void> {
      // Probe once to detect dim
      if (!dimDetected) {
        try {
          const probe = await provider.embedQuery("dim-probe");
          if (probe.length > 0) {
            cachedDim = probe.length;
            dimDetected = true;
            logger?.info?.(
              `[memory-context] embedding: using ${provider.id} (${cachedDim}-dim, model=${provider.model})`,
            );
          }
        } catch (err) {
          logger?.warn?.(
            `[memory-context] embedding probe failed for ${provider.id}: ${String(err)}`,
          );
        }
      }
    },
  };
}

/**
 * Map memory-context embedding model names to the unified provider system.
 *
 * Fallback chain (auto / gemini):
 *   Gemini API → OpenAI → Voyage → Local (EmbeddingGemma-300M) → noop (BM25)
 *
 * When "transformer" is requested explicitly:
 *   Local (EmbeddingGemma-300M) → noop (BM25)
 */
export async function createEmbeddingProvider(
  cfg: OpenClawConfig | undefined,
  type: "gemini" | "transformer" | "hash" | "auto",
  logger?: { warn: (msg: string) => void; info?: (msg: string) => void },
): Promise<EmbeddingProvider> {
  // Map memory-context types to unified provider types.
  // "transformer" maps to "local" which uses the local ONNX embedding model.
  const providerMap: Record<string, EmbeddingProviderRequest> = {
    gemini: "auto", // "gemini" in memory-context means "best available" — use auto
    auto: "auto",
    transformer: "local",
  };

  // Hash is a special case — not part of the unified system.
  // Kept as a trivial deterministic fallback (no semantic search).
  if (type === "hash") {
    logger?.info?.("[memory-context] embedding: using hash (keyword overlap, no semantic search)");
    return createHashEmbedding(384);
  }

  const unifiedProvider = providerMap[type] ?? "auto";

  try {
    const result: EmbeddingProviderResult = await createUnifiedEmbeddingProvider({
      config: cfg ?? ({} as OpenClawConfig),
      provider: unifiedProvider,
      model: "", // auto-detect
      fallback: unifiedProvider === "local" ? "none" : "local",
    });

    if (result.fallbackReason) {
      logger?.warn?.(`[memory-context] embedding fallback: ${result.fallbackReason}`);
    }

    // If unified system exhausted all providers → noop, use hash instead.
    // Hash provides n-gram vector similarity which is better than noop (BM25-only).
    const provider = result.provider;
    if (!provider || provider.id === "none") {
      logger?.info?.(
        "[memory-context] embedding: using hash (keyword overlap, no semantic search)",
      );
      return createHashEmbedding(384);
    }

    const adapter = wrapUnifiedProvider(provider, logger);
    await adapter.init?.();

    // If probe failed (e.g. Gemini region restriction), dim stays 0.
    // Fall back to hash embedding to avoid VectorIndex: invalid dim 0.
    if (adapter.dim <= 0) {
      logger?.warn?.(
        `[memory-context] embedding dim=0 after probe (provider=${adapter.name}), falling back to hash`,
      );
      return createHashEmbedding(384);
    }

    // Wrap with LRU cache to avoid redundant API calls for repeated queries
    return withEmbeddingCache(adapter);
  } catch (err) {
    logger?.warn?.(
      `[memory-context] unified embedding failed (${String(err)}), using hash fallback`,
    );
    return createHashEmbedding(384);
  }
}

// --- Minimal hash embedding kept as last-resort fallback ---

import { createHash } from "node:crypto";

function createHashEmbedding(dim: number): EmbeddingProvider {
  return {
    dim,
    name: "hash",
    async embed(text: string): Promise<number[]> {
      const normalized = text
        .toLowerCase()
        .replace(/\s+/g, " ")
        .replace(/[^\p{L}\p{N}\s@.+-]/gu, " ")
        .trim();
      const vec = Array.from({ length: dim }, () => 0);
      const ngram = 3;

      // Generate character n-grams
      if (!normalized || normalized.length <= ngram) {
        if (normalized) {
          const digest = createHash("sha256").update(normalized).digest();
          const idx = digest.readUInt32LE(0) % dim;
          vec[idx] += (digest[4] & 1) === 0 ? 1 : -1;
        }
      } else {
        const padded = ` ${normalized} `;
        for (let i = 0; i <= padded.length - ngram; i++) {
          const g = padded.slice(i, i + ngram);
          const digest = createHash("sha256").update(g).digest();
          const idx = digest.readUInt32LE(0) % dim;
          vec[idx] += (digest[4] & 1) === 0 ? 1 : -1;
        }
      }

      // Normalize to unit length
      let norm = 0;
      for (const v of vec) {
        norm += v * v;
      }
      norm = Math.sqrt(norm);
      if (norm > 0) {
        for (let i = 0; i < vec.length; i++) {
          vec[i] /= norm;
        }
      }
      return vec;
    },
  };
}
