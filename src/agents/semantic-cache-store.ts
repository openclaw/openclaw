/**
 * Semantic Cache Store - SQLite-backed implementation
 *
 * A production-ready caching system that stores embeddings of previous questions
 * and their corresponding answers in SQLite with vector similarity search.
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "../config/config.js";
import { resolveStateDir } from "../config/paths.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { createOllamaEmbeddingProvider } from "../memory/embeddings-ollama.js";
import type { EmbeddingProvider } from "../memory/embeddings.js";
import { resolveUserPath } from "../utils.js";

const log = createSubsystemLogger("semantic-cache-store");

export type SemanticCacheEntry = {
  id: string;
  query: string;
  queryEmbedding: number[];
  response: string;
  metadata: {
    provider: string;
    model: string;
    timestamp: number;
    ttl?: number;
  };
};

export type SemanticCacheConfig = {
  enabled: boolean;
  similarityThreshold: number;
  maxEntries: number;
  ttlMs: number;
  embeddingProvider: "ollama" | "openai" | "local" | "auto";
  embeddingModel?: string;
  baseUrl?: string;
  apiKey?: string;
  storePath?: string;
  minQueryLength: number;
  maxQueryLength: number;
};

export type CacheSearchResult = {
  entry: SemanticCacheEntry;
  similarity: number;
};

const DEFAULT_SIMILARITY_THRESHOLD = 0.85;
const DEFAULT_MAX_ENTRIES = 10_000;
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const DEFAULT_MIN_QUERY_LENGTH = 10;
const DEFAULT_MAX_QUERY_LENGTH = 2000;
const DEFAULT_OLLAMA_EMBEDDING_MODEL = "nomic-embed-text";

/**
 * Calculate cosine similarity between two vectors
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error(`Vector dimension mismatch: ${a.length} vs ${b.length}`);
  }

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  if (normA === 0 || normB === 0) {
    return 0;
  }

  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * SQLite-backed semantic cache store
 */
/** Minimal interface for the better-sqlite3 Database we use at runtime. */
type SqliteDb = {
  exec(sql: string): void;
  prepare(sql: string): { run(...args: unknown[]): void; all(): unknown[] };
};

export class SemanticCacheStore {
  private db: SqliteDb | null = null;
  private embeddingProvider: EmbeddingProvider | null = null;
  private config: SemanticCacheConfig;
  private storePath: string;
  private initialized = false;
  private inMemoryCache: Map<string, SemanticCacheEntry> = new Map();

  constructor(
    config: SemanticCacheConfig,
    agentId?: string,
    embeddingProvider?: EmbeddingProvider,
  ) {
    this.config = config;
    this.storePath = this.resolveStorePath(agentId);
    // Allow injecting a provider (useful for testing without a live Ollama).
    if (embeddingProvider) {
      this.embeddingProvider = embeddingProvider;
      this.initialized = true; // Skip auto-init when provider is pre-set.
    }
  }

  /**
   * Resolve the store path
   */
  private resolveStorePath(agentId?: string): string {
    if (this.config.storePath) {
      const withToken =
        this.config.storePath.includes("{agentId}") && agentId
          ? this.config.storePath.replaceAll("{agentId}", agentId)
          : this.config.storePath;
      return resolveUserPath(withToken);
    }

    const stateDir = resolveStateDir(process.env, os.homedir);
    const fileName = agentId ? `semantic-cache-${agentId}.sqlite` : "semantic-cache.sqlite";
    return path.join(stateDir, "cache", fileName);
  }

  /**
   * Initialize the database and embedding provider
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    // Ensure directory exists
    const dir = path.dirname(this.storePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // Try to initialize SQLite
    try {
      // better-sqlite3 is an optional runtime dependency; gracefully skip when unavailable.
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore - optional dep, not listed in package.json types
      const sqlite3 = await import("better-sqlite3");
      this.db = sqlite3.default(this.storePath);
      this.initializeSchema();
      this.loadFromDatabase();
    } catch {
      log.warn("SQLite not available, using in-memory cache only");
      this.db = null;
    }

    // Initialize embedding provider
    await this.initializeEmbeddingProvider();

    this.initialized = true;
    log.info(`Semantic cache store initialized at ${this.storePath}`);
  }

  /**
   * Initialize database schema
   */
  private initializeSchema(): void {
    if (!this.db) {
      return;
    }

    // Create cache entries table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS cache_entries (
        id TEXT PRIMARY KEY,
        query TEXT NOT NULL,
        query_embedding BLOB NOT NULL,
        response TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        ttl INTEGER
      )
    `);

    // Create index for timestamp-based cleanup
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_timestamp ON cache_entries(timestamp)
    `);
  }

  /**
   * Load existing entries from database
   */
  private loadFromDatabase(): void {
    if (!this.db) {
      return;
    }

    try {
      type DbRow = {
        id: string;
        query: string;
        query_embedding: ArrayBuffer;
        response: string;
        provider: string;
        model: string;
        timestamp: number;
        ttl: number | undefined;
      };
      const rows = this.db.prepare("SELECT * FROM cache_entries").all() as DbRow[];
      for (const row of rows) {
        const embeddingArray = new Float32Array(row.query_embedding);
        const entry: SemanticCacheEntry = {
          id: row.id,
          query: row.query,
          queryEmbedding: Array.from(embeddingArray),
          response: row.response,
          metadata: {
            provider: row.provider,
            model: row.model,
            timestamp: row.timestamp,
            ttl: row.ttl,
          },
        };
        this.inMemoryCache.set(entry.id, entry);
      }
      log.info(`Loaded ${this.inMemoryCache.size} entries from database`);
    } catch (error) {
      log.error(`Failed to load cache from database: ${String(error)}`);
    }
  }

  /**
   * Initialize the embedding provider
   */
  private async initializeEmbeddingProvider(): Promise<void> {
    const providerConfig = {
      config: {} as OpenClawConfig,
      provider: "ollama" as const,
      fallback: "none" as const,
      model: this.config.embeddingModel ?? DEFAULT_OLLAMA_EMBEDDING_MODEL,
      remote: {
        baseUrl: this.config.baseUrl,
        // SecretInput accepts a plain string
        apiKey: this.config.apiKey,
      },
    };

    switch (this.config.embeddingProvider) {
      case "openai":
      case "auto":
        // "openai" and "auto" are accepted by the schema but not yet implemented;
        // fall back to Ollama and warn so misconfiguration is visible.
        log.warn(
          `Embedding provider "${this.config.embeddingProvider}" is not yet implemented; falling back to Ollama.`,
        );
      // falls through
      case "ollama":
      case "local":
      default: {
        const { provider } = await createOllamaEmbeddingProvider(providerConfig);
        this.embeddingProvider = provider;
        break;
      }
    }
  }

  /**
   * Search for similar cached entries
   */
  async search(query: string): Promise<CacheSearchResult | null> {
    if (!this.config.enabled) {
      return null;
    }

    await this.initialize();

    if (!this.shouldCacheQuery(query)) {
      return null;
    }

    const queryEmbedding = await this.embedText(query);

    // Clean expired entries
    await this.cleanupExpired();

    let bestMatch: CacheSearchResult | null = null;

    for (const entry of this.inMemoryCache.values()) {
      const similarity = cosineSimilarity(queryEmbedding, entry.queryEmbedding);

      if (similarity >= this.config.similarityThreshold) {
        if (!bestMatch || similarity > bestMatch.similarity) {
          bestMatch = { entry, similarity };
        }
      }
    }

    if (bestMatch) {
      log.info(
        `Cache hit: similarity=${bestMatch.similarity.toFixed(3)}, query="${query.slice(0, 50)}..."`,
      );
    } else {
      log.debug(`Cache miss: query="${query.slice(0, 50)}..."`);
    }

    return bestMatch;
  }

  /**
   * Store a new entry in the cache
   */
  async store(
    query: string,
    response: string,
    metadata: { provider: string; model: string },
  ): Promise<SemanticCacheEntry> {
    if (!this.config.enabled) {
      throw new Error("Semantic cache is disabled");
    }

    await this.initialize();

    if (!this.shouldCacheQuery(query)) {
      throw new Error(`Query length ${query.length} is outside cacheable range`);
    }

    // Check if we need to evict entries
    if (this.inMemoryCache.size >= this.config.maxEntries) {
      await this.evictOldestEntries();
    }

    const queryEmbedding = await this.embedText(query);

    const entry: SemanticCacheEntry = {
      id: randomUUID(),
      query,
      queryEmbedding,
      response,
      metadata: {
        ...metadata,
        timestamp: Date.now(),
        ttl: this.config.ttlMs,
      },
    };

    // Store in memory
    this.inMemoryCache.set(entry.id, entry);

    // Store in SQLite if available
    if (this.db) {
      const embeddingBuffer = Buffer.from(new Float32Array(queryEmbedding).buffer);
      this.db
        .prepare(
          `INSERT INTO cache_entries (id, query, query_embedding, response, provider, model, timestamp, ttl)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          entry.id,
          entry.query,
          embeddingBuffer,
          entry.response,
          entry.metadata.provider,
          entry.metadata.model,
          entry.metadata.timestamp,
          entry.metadata.ttl,
        );
    }

    log.info(`Cached query: id=${entry.id}, cache size=${this.inMemoryCache.size}`);

    return entry;
  }

  /**
   * Check if query should be cached
   */
  private shouldCacheQuery(query: string): boolean {
    const length = query.length;
    return length >= this.config.minQueryLength && length <= this.config.maxQueryLength;
  }

  /**
   * Generate embedding for text
   */
  private async embedText(text: string): Promise<number[]> {
    if (!this.embeddingProvider) {
      await this.initialize();
    }
    if (!this.embeddingProvider) {
      throw new Error(
        `Embedding provider failed to initialise (configured: "${this.config.embeddingProvider}"). Check that the provider is reachable.`,
      );
    }
    return this.embeddingProvider.embedQuery(text);
  }

  /**
   * Clean up expired entries
   */
  private async cleanupExpired(): Promise<void> {
    const now = Date.now();
    const expiredIds: string[] = [];

    for (const [id, entry] of this.inMemoryCache) {
      if (entry.metadata.ttl && now > entry.metadata.timestamp + entry.metadata.ttl) {
        expiredIds.push(id);
      }
    }

    for (const id of expiredIds) {
      this.inMemoryCache.delete(id);
    }

    if (this.db && expiredIds.length > 0) {
      const placeholders = expiredIds.map(() => "?").join(",");
      this.db.prepare(`DELETE FROM cache_entries WHERE id IN (${placeholders})`).run(...expiredIds);
    }

    if (expiredIds.length > 0) {
      log.debug(`Cleaned up ${expiredIds.length} expired cache entries`);
    }
  }

  /**
   * Evict oldest entries when cache is full
   */
  private async evictOldestEntries(): Promise<void> {
    const entriesToRemove = Math.ceil(this.config.maxEntries * 0.1); // Remove 10%
    const sortedEntries = Array.from(this.inMemoryCache.entries()).toSorted(
      (a, b) => a[1].metadata.timestamp - b[1].metadata.timestamp,
    );

    const idsToRemove = sortedEntries.slice(0, entriesToRemove).map(([id]) => id);

    for (const id of idsToRemove) {
      this.inMemoryCache.delete(id);
    }

    if (this.db && idsToRemove.length > 0) {
      const placeholders = idsToRemove.map(() => "?").join(",");
      this.db
        .prepare(`DELETE FROM cache_entries WHERE id IN (${placeholders})`)
        .run(...idsToRemove);
    }

    log.debug(`Evicted ${idsToRemove.length} oldest cache entries`);
  }

  /**
   * Clear all cached entries
   */
  clear(): void {
    this.inMemoryCache.clear();

    if (this.db) {
      this.db.prepare("DELETE FROM cache_entries").run();
    }

    log.info("Semantic cache cleared");
  }

  /**
   * Get cache statistics
   */
  getStats(): {
    size: number;
    maxEntries: number;
    similarityThreshold: number;
    embeddingProvider: string;
  } {
    return {
      size: this.inMemoryCache.size,
      maxEntries: this.config.maxEntries,
      similarityThreshold: this.config.similarityThreshold,
      embeddingProvider: this.config.embeddingProvider,
    };
  }
}

/**
 * Create a semantic cache store instance
 */
export function createSemanticCacheStore(
  config: SemanticCacheConfig,
  agentId?: string,
  embeddingProvider?: EmbeddingProvider,
): SemanticCacheStore {
  return new SemanticCacheStore(config, agentId, embeddingProvider);
}

/**
 * Resolve semantic cache configuration from OpenClaw config
 */
export function resolveSemanticCacheConfig(
  cfg: OpenClawConfig | undefined,
): SemanticCacheConfig | null {
  const cacheConfig = cfg?.agents?.defaults?.semanticCache;

  if (!cacheConfig?.enabled) {
    return null;
  }

  const embeddingProvider = cacheConfig.embeddingProvider ?? "ollama";

  return {
    enabled: true,
    similarityThreshold: cacheConfig.similarityThreshold ?? DEFAULT_SIMILARITY_THRESHOLD,
    maxEntries: cacheConfig.maxEntries ?? DEFAULT_MAX_ENTRIES,
    ttlMs: cacheConfig.ttlMs ?? DEFAULT_TTL_MS,
    embeddingProvider,
    embeddingModel: cacheConfig.embeddingModel ?? DEFAULT_OLLAMA_EMBEDDING_MODEL,
    baseUrl: cacheConfig.baseUrl,
    apiKey: cacheConfig.apiKey,
    storePath: cacheConfig.storePath,
    minQueryLength: cacheConfig.minQueryLength ?? DEFAULT_MIN_QUERY_LENGTH,
    maxQueryLength: cacheConfig.maxQueryLength ?? DEFAULT_MAX_QUERY_LENGTH,
  };
}
