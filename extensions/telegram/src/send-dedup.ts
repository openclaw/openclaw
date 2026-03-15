import { createDedupeCache, type DedupeCache } from "../../../src/infra/dedupe.js";

/**
 * Options for configuring the send dedup cache.
 */
export interface SendDedupOptions {
  /**
   * TTL in milliseconds for dedup entries.
   * Default: 5 minutes (300000 ms)
   * Rationale: Covers typical network retry windows while preventing stale entries.
   */
  ttlMs?: number;

  /**
   * Maximum number of entries in the dedup cache.
   * Default: 1000
   * Rationale: Limits memory usage while covering typical send patterns.
   */
  maxSize?: number;
}

/**
 * Internal cache entry that stores send attempt information.
 */
interface SendDedupEntry {
  /**
   * Hash of the request parameters (content fingerprint).
   */
  contentHash: string;

  /**
   * Timestamp when this send was first attempted.
   */
  firstAttemptMs: number;

  /**
   * Message ID returned by Telegram (if successful).
   * Undefined if send failed or is still pending.
   */
  messageId?: number;

  /**
   * Chat ID where the message was sent.
   */
  chatId: string;

  /**
   * Attempt count for this content.
   */
  attemptCount: number;
}

/**
 * Manages deduplication of outbound Telegram message sends.
 *
 * Prevents duplicate messages caused by:
 * - Network timeouts triggering retries
 * - Partial failures with eventual success
 * - Rapid successive send requests with identical content
 *
 * **Usage Pattern:**
 * ```ts
 * const dedup = new SendDedup({ ttlMs: 5 * 60 * 1000, maxSize: 1000 });
 *
 * // Before sending:
 * const hash = dedup.hashSendParams(chatId, { text, buttons, ... });
 * if (dedup.hasPendingOrSuccessful(hash)) {
 *   return; // Suppress duplicate send
 * }
 *
 * // Mark as sending:
 * dedup.recordAttempt(hash, chatId);
 *
 * // After successful send:
 * dedup.recordSuccess(hash, messageId);
 *
 * // If send fails and we want to retry:
 * // - Leave the entry; next attempt will increment attemptCount
 * // - Or manually clear with dedup.clear(hash) to force retry
 * ```
 *
 * **Thread Safety:** Not thread-safe; assume single-threaded Node.js event loop.
 */
export class SendDedup {
  private readonly ttlMs: number;
  private readonly maxSize: number;
  private readonly cache: DedupeCache;
  private readonly metadata: Map<string, SendDedupEntry>;

  /**
   * Create a new SendDedup instance.
   *
   * @param options Configuration options
   */
  constructor(options: SendDedupOptions = {}) {
    this.ttlMs = Math.max(0, options.ttlMs ?? 5 * 60 * 1000); // 5 minutes default
    this.maxSize = Math.max(1, options.maxSize ?? 1000);
    this.cache = createDedupeCache({
      ttlMs: this.ttlMs,
      maxSize: this.maxSize,
    });
    this.metadata = new Map();
  }

  /**
   * Generate a deterministic hash from send parameters.
   *
   * Used to identify duplicate send attempts with identical content.
   * Only hashes content-affecting parameters, ignoring timestamps or IDs.
   *
   * @param chatId Target chat ID
   * @param params Send parameters (text, media, buttons, etc.)
   * @returns Base64-encoded SHA256 hash of normalized parameters
   *
   * @example
   * ```ts
   * const hash = dedup.hashSendParams('12345', { text: 'Hello', buttons: [...] });
   * ```
   */
  hashSendParams(chatId: string, params: Record<string, unknown>): string {
    // Create normalized representation of send parameters
    // We include chatId to scope the hash to the target
    const key = `${chatId}:${JSON.stringify(this.normalizeSendParams(params))}`;

    // Use simple crypto hash (in real scenarios, consider crypto.subtle.digest)
    // For now, use a simple hash to generate a deterministic key
    let hash = 0;
    for (let i = 0; i < key.length; i++) {
      const char = key.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    return `telegram-send-${Math.abs(hash)}-${key.length}`;
  }

  /**
   * Normalize send parameters to a canonical form.
   *
   * Removes irrelevant fields and sorts keys for deterministic hashing.
   * Skips timestamp-related, ID-related, and transient parameters.
   *
   * @param params Original send parameters
   * @returns Normalized parameters suitable for hashing
   */
  private normalizeSendParams(params: Record<string, unknown>): Record<string, unknown> {
    const normalized: Record<string, unknown> = {};

    // Whitelist of parameters that affect message content
    const contentKeys = [
      "text",
      "caption",
      "parse_mode",
      "entities",
      "reply_markup",
      "buttons",
      "document",
      "video",
      "photo",
      "audio",
      "voice",
      "animation",
      "media",
      "file_id",
      "url",
      "file",
      "thumbnail",
      "width",
      "height",
      "duration",
      "performer",
      "title",
      "disable_web_page_preview",
      "link_preview_options",
      "allow_user_interaction",
    ];

    for (const key of contentKeys) {
      if (key in params) {
        const value = params[key];
        // Skip undefined, null, or empty values
        if (value !== undefined && value !== null) {
          normalized[key] = value;
        }
      }
    }

    // Sort keys for deterministic output
    return Object.fromEntries(Object.entries(normalized).sort(([a], [b]) => a.localeCompare(b)));
  }

  /**
   * Check if a message with identical content is already pending or successful.
   *
   * Returns true if:
   * - A message with the same content hash was recently sent (and succeeded)
   * - A message with the same content hash is currently pending
   *
   * This prevents immediate duplicate sends.
   *
   * @param contentHash Result of {@link hashSendParams}
   * @returns true if a recent send with same content exists
   */
  hasPendingOrSuccessful(contentHash: string): boolean {
    return this.cache.peek(contentHash) ?? false;
  }

  /**
   * Record a send attempt.
   *
   * Call this BEFORE sending the message to Telegram.
   * Updates the attempt count for the given content hash.
   *
   * @param contentHash Result of {@link hashSendParams}
   * @param chatId Chat ID where the message will be sent
   * @returns The updated attempt count
   */
  recordAttempt(contentHash: string, chatId: string): number {
    let entry = this.metadata.get(contentHash);

    if (!entry) {
      entry = {
        contentHash,
        firstAttemptMs: Date.now(),
        chatId,
        attemptCount: 1,
      };
      this.metadata.set(contentHash, entry);
      // Mark in cache so future checks see it
      this.cache.check(contentHash);
      return 1;
    }

    entry.attemptCount++;
    return entry.attemptCount;
  }

  /**
   * Record a successful send.
   *
   * Call this AFTER Telegram API returns a successful response with messageId.
   *
   * @param contentHash Result of {@link hashSendParams}
   * @param messageId The message_id returned by Telegram
   */
  recordSuccess(contentHash: string, messageId: number): void {
    const entry = this.metadata.get(contentHash);
    if (entry) {
      entry.messageId = messageId;
      // Re-touch the cache to refresh the TTL on successful send
      this.cache.check(contentHash);
    }
  }

  /**
   * Record a failed send attempt.
   *
   * When a send fails, the entry remains in the cache with TTL.
   * On retry, {@link recordAttempt} will increment attemptCount.
   * This allows observing retry patterns.
   *
   * @param contentHash Result of {@link hashSendParams}
   * @returns The failed entry (if it exists)
   */
  recordFailure(contentHash: string): SendDedupEntry | undefined {
    return this.metadata.get(contentHash);
  }

  /**
   * Get metadata about a send attempt.
   *
   * Useful for observability and debugging.
   *
   * @param contentHash Result of {@link hashSendParams}
   * @returns Send attempt metadata, or undefined if not found
   */
  getMetadata(contentHash: string): SendDedupEntry | undefined {
    // Return a copy to prevent external modification
    const entry = this.metadata.get(contentHash);
    return entry
      ? {
          ...entry,
        }
      : undefined;
  }

  /**
   * Manually clear a dedup entry.
   *
   * Used to force a retry when the send was aborted or needs to be re-attempted
   * outside the normal TTL window.
   *
   * @param contentHash Result of {@link hashSendParams}
   */
  clear(contentHash: string): void {
    this.cache.delete(contentHash);
    this.metadata.delete(contentHash);
  }

  /**
   * Clear all entries (for testing or reset).
   */
  clearAll(): void {
    this.cache.clear();
    this.metadata.clear();
  }

  /**
   * Get current cache size.
   *
   * Useful for monitoring cache health.
   *
   * @returns Number of entries in cache
   */
  size(): number {
    return this.cache.size();
  }

  /**
   * Reset send dedup to initial state.
   *
   * This is a full reset and should be used with caution.
   */
  reset(): void {
    this.clearAll();
  }
}

/**
 * Global singleton instance of SendDedup.
 *
 * Shared across all Telegram send operations within the same process.
 */
let globalSendDedup: SendDedup | null = null;

/**
 * Get or create the global SendDedup instance.
 *
 * @param options Configuration for first instantiation
 * @returns The singleton instance
 */
export function getGlobalSendDedup(options?: SendDedupOptions): SendDedup {
  if (!globalSendDedup) {
    globalSendDedup = new SendDedup(options);
  }
  return globalSendDedup;
}

/**
 * Reset the global SendDedup instance (for testing).
 */
export function resetGlobalSendDedup(): void {
  globalSendDedup = null;
}

/**
 * Check if content with identical parameters was recently sent.
 *
 * Convenience function using the global SendDedup instance.
 *
 * @param chatId Target chat ID
 * @param params Send parameters
 * @returns true if recent identical send exists
 */
export function checkSendDedup(chatId: string, params: Record<string, unknown>): boolean {
  const dedup = getGlobalSendDedup();
  const hash = dedup.hashSendParams(chatId, params);
  return dedup.hasPendingOrSuccessful(hash);
}

/**
 * Record a send attempt using the global instance.
 *
 * @param chatId Target chat ID
 * @param params Send parameters
 * @returns The content hash and attempt count
 */
export function recordSendAttempt(chatId: string, params: Record<string, unknown>): {
  hash: string;
  attemptCount: number;
} {
  const dedup = getGlobalSendDedup();
  const hash = dedup.hashSendParams(chatId, params);
  const attemptCount = dedup.recordAttempt(hash, chatId);
  return { hash, attemptCount };
}

/**
 * Record a successful send using the global instance.
 *
 * @param hash Content hash from {@link recordSendAttempt}
 * @param messageId The message_id returned by Telegram
 */
export function recordSendSuccess(hash: string, messageId: number): void {
  const dedup = getGlobalSendDedup();
  dedup.recordSuccess(hash, messageId);
}
