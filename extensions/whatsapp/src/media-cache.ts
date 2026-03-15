import crypto from "node:crypto";
import path from "node:path";

/**
 * Represents a cached media entry.
 */
type CacheEntry = {
  /** Compressed media buffer */
  buffer: Buffer;
  /** MIME type of the media */
  mimetype?: string;
  /** Original file name if available */
  fileName?: string;
  /** Timestamp when the entry was created (ms) */
  cachedAt: number;
};

/**
 * Configuration for the media cache.
 */
export interface MediaCacheConfig {
  /** TTL for cache entries in milliseconds (default: 24 hours) */
  ttlMs?: number;
  /** Maximum number of entries to keep in the cache (default: 1000) */
  maxSize?: number;
  /** Whether to enable the cache (default: true) */
  enabled?: boolean;
}

/**
 * Cache key generation strategy for media.
 * Can be either based on message ID or URL hash.
 */
export type CacheKeyStrategy = "message-id" | "url-hash";

/**
 * MediaCache implementation for WhatsApp media deduplication.
 *
 * @example
 * const cache = new MediaCache({ ttlMs: 24 * 60 * 60 * 1000 });
 * const cacheKey = cache.generateKey("msg_123", "url-hash");
 * const cached = cache.get(cacheKey);
 * if (cached) {
 *   return cached;
 * }
 * const result = await downloadMedia();
 * cache.set(cacheKey, result);
 */
export class MediaCache {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly ttlMs: number;
  private readonly maxSize: number;
  private readonly enabled: boolean;

  constructor(config?: MediaCacheConfig) {
    this.ttlMs = config?.ttlMs ?? 24 * 60 * 60 * 1000; // 24 hours default
    this.maxSize = Math.max(1, Math.floor(config?.maxSize ?? 1000));
    this.enabled = config?.enabled !== false;
  }

  /**
   * Generate a cache key from media identifiers.
   * Uses SHA256 hash for URL-based keys to ensure consistency.
   *
   * @param identifier - Message ID, URL, or other unique identifier
   * @param strategy - Key generation strategy ("message-id" or "url-hash")
   * @returns Cache key string
   */
  generateKey(identifier: string, strategy: CacheKeyStrategy = "message-id"): string {
    if (strategy === "message-id") {
      return `msg:${identifier}`;
    }
    // For URL hashing, use SHA256 to create a stable, collision-resistant key
    const hash = crypto.createHash("sha256").update(identifier).digest("hex");
    return `url:${hash.substring(0, 32)}`; // Use first 32 chars for brevity
  }

  /**
   * Retrieve a cached media entry.
   *
   * @param key - Cache key (generate using generateKey)
   * @returns Cached media result or undefined if not found or expired
   */
  get(key: string): Omit<CacheEntry, "cachedAt"> | undefined {
    if (!this.enabled) {
      return undefined;
    }

    this.pruneExpired();
    const entry = this.cache.get(key);

    if (!entry) {
      return undefined;
    }

    // Return media data without the internal timestamp
    return {
      buffer: entry.buffer,
      mimetype: entry.mimetype,
      fileName: entry.fileName,
    };
  }

  /**
   * Store a media entry in the cache.
   *
   * @param key - Cache key (generate using generateKey)
   * @param data - Media data to cache
   * @param data.buffer - Media buffer
   * @param data.mimetype - MIME type of the media
   * @param data.fileName - Original file name (optional)
   */
  set(
    key: string,
    data: {
      buffer: Buffer;
      mimetype?: string;
      fileName?: string;
    },
  ): void {
    if (!this.enabled) {
      return;
    }

    this.pruneExpired();

    // Refresh insertion order so active keys are less likely to be evicted
    if (this.cache.has(key)) {
      this.cache.delete(key);
    }

    this.cache.set(key, {
      buffer: data.buffer,
      mimetype: data.mimetype,
      fileName: data.fileName,
      cachedAt: Date.now(),
    });

    this.evictToMaxSize();
  }

  /**
   * Check if a key exists in the cache and is not expired.
   *
   * @param key - Cache key
   * @returns true if the entry exists and is not expired
   */
  has(key: string): boolean {
    if (!this.enabled) {
      return false;
    }

    const entry = this.cache.get(key);
    if (!entry) {
      return false;
    }

    const now = Date.now();
    if (this.ttlMs > 0 && now - entry.cachedAt > this.ttlMs) {
      this.cache.delete(key);
      return false;
    }

    return true;
  }

  /**
   * Remove an entry from the cache.
   *
   * @param key - Cache key
   */
  delete(key: string): void {
    this.cache.delete(key);
  }

  /**
   * Clear all entries from the cache.
   */
  clear(): void {
    this.cache.clear();
  }

  /**
   * Get cache statistics for monitoring.
   *
   * @returns Object containing cache size and configuration info
   */
  getStats(): {
    size: number;
    maxSize: number;
    ttlMs: number;
    enabled: boolean;
  } {
    return {
      size: this.cache.size,
      maxSize: this.maxSize,
      ttlMs: this.ttlMs,
      enabled: this.enabled,
    };
  }

  /**
   * Remove expired entries from the cache.
   *
   * @private
   */
  private pruneExpired(): void {
    if (this.ttlMs <= 0) {
      return;
    }

    const now = Date.now();
    const keysToDelete: string[] = [];

    for (const [key, entry] of this.cache.entries()) {
      if (now - entry.cachedAt > this.ttlMs) {
        keysToDelete.push(key);
      }
    }

    for (const key of keysToDelete) {
      this.cache.delete(key);
    }
  }

  /**
   * Evict oldest entries if cache exceeds maxSize.
   * Uses FIFO eviction based on insertion order.
   *
   * @private
   */
  private evictToMaxSize(): void {
    while (this.cache.size > this.maxSize) {
      // Map iteration order is insertion order, so first entry is oldest
      const oldestKey = this.cache.keys().next().value;
      if (typeof oldestKey !== "string") {
        break;
      }
      this.cache.delete(oldestKey);
    }
  }
}
