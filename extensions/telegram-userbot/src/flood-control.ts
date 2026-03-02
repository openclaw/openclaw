/**
 * Token-bucket rate limiter and flood controller for Telegram userbot.
 *
 * Prevents account bans by enforcing global and per-chat rate limits,
 * adding human-like jitter, and respecting Telegram's FLOOD_WAIT responses.
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

// ---------------------------------------------------------------------------
// Token bucket (internal)
// ---------------------------------------------------------------------------

/**
 * Simple token bucket for rate limiting.
 *
 * Tokens refill at a constant rate up to a capacity cap.
 * Calling `acquire()` consumes one token, waiting if none are available.
 */
class TokenBucket {
  private tokens: number;
  private lastRefill: number;
  private readonly rate: number; // tokens per second
  private readonly capacity: number; // max tokens

  constructor(rate: number, capacity?: number) {
    this.rate = rate;
    this.capacity = capacity ?? rate;
    this.tokens = this.capacity;
    this.lastRefill = Date.now();
  }

  /** Acquire one token. Returns the number of milliseconds waited (0 if immediate). */
  async acquire(): Promise<number> {
    this.refill();

    if (this.tokens >= 1) {
      this.tokens -= 1;
      return 0;
    }

    // Calculate how long until the next token is available
    const waitMs = ((1 - this.tokens) / this.rate) * 1000;
    await sleep(waitMs);
    this.refill();
    this.tokens -= 1;
    return waitMs;
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.rate);
    this.lastRefill = now;
  }
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface FloodControllerConfig {
  /** Global messages per second (default: 20) */
  globalRate?: number;
  /** Per-chat messages per second (default: 1) */
  perChatRate?: number;
  /** Random jitter range in ms [min, max] (default: [50, 200]) */
  jitterMs?: [number, number];
  /** TTL for unused per-chat buckets in ms, for LRU eviction (default: 300_000 = 5 min) */
  chatBucketTtlMs?: number;
}

export interface FloodControllerMetrics {
  totalAcquires: number;
  totalWaits: number;
  totalFloodWaits: number;
  avgWaitMs: number;
}

// Resolved config with all fields required
type ResolvedConfig = Required<FloodControllerConfig>;

const DEFAULT_CONFIG: ResolvedConfig = {
  globalRate: 20,
  perChatRate: 1,
  jitterMs: [50, 200],
  chatBucketTtlMs: 300_000,
};

// ---------------------------------------------------------------------------
// FloodController
// ---------------------------------------------------------------------------

/**
 * Rate-limits Telegram API calls to prevent account bans.
 *
 * Combines three layers of protection:
 *  1. Global token bucket (e.g. 20 msgs/sec across all chats)
 *  2. Per-chat token bucket (e.g. 1 msg/sec per chat)
 *  3. Human-like random jitter on every call
 *
 * Additionally honours Telegram's FLOOD_WAIT responses via `reportFloodWait`.
 */
export class FloodController {
  private globalBucket: TokenBucket;
  private chatBuckets: Map<string, { bucket: TokenBucket; lastUsed: number }>;
  private floodWaitUntil = 0;
  private config: ResolvedConfig;

  // Metrics
  private totalAcquires = 0;
  private totalWaits = 0;
  private totalFloodWaits = 0;
  private totalWaitMs = 0;

  constructor(config?: FloodControllerConfig) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.globalBucket = new TokenBucket(this.config.globalRate);
    this.chatBuckets = new Map();
  }

  /**
   * Acquire permission to send a message to `chatId`.
   *
   * Blocks until all rate-limit layers allow the request, then adds jitter.
   */
  async acquire(chatId: string): Promise<void> {
    this.totalAcquires++;

    // 1. Honour any active FLOOD_WAIT from Telegram
    const now = Date.now();
    if (now < this.floodWaitUntil) {
      const waitMs = this.floodWaitUntil - now;
      this.totalWaits++;
      this.totalWaitMs += waitMs;
      await sleep(waitMs);
    }

    // 2. Global rate bucket
    const globalWait = await this.globalBucket.acquire();
    if (globalWait > 0) {
      this.totalWaits++;
      this.totalWaitMs += globalWait;
    }

    // 3. Per-chat rate bucket
    const chatBucket = this.getOrCreateChatBucket(chatId);
    const chatWait = await chatBucket.acquire();
    if (chatWait > 0) {
      this.totalWaits++;
      this.totalWaitMs += chatWait;
    }

    // 4. Human-like jitter
    const [minJitter, maxJitter] = this.config.jitterMs;
    const jitter = minJitter + Math.random() * (maxJitter - minJitter);
    await sleep(jitter);
    this.totalWaitMs += jitter;
  }

  /**
   * Report a FLOOD_WAIT response from Telegram.
   * All subsequent `acquire` calls will block until the wait period expires.
   */
  reportFloodWait(seconds: number): void {
    this.floodWaitUntil = Date.now() + seconds * 1000;
    this.totalFloodWaits++;
  }

  /** Return current rate-limiting metrics. */
  getMetrics(): FloodControllerMetrics {
    return {
      totalAcquires: this.totalAcquires,
      totalWaits: this.totalWaits,
      totalFloodWaits: this.totalFloodWaits,
      avgWaitMs: this.totalAcquires > 0 ? this.totalWaitMs / this.totalAcquires : 0,
    };
  }

  /** Reset all metrics, buckets, and flood-wait state. Useful for testing. */
  reset(): void {
    this.totalAcquires = 0;
    this.totalWaits = 0;
    this.totalFloodWaits = 0;
    this.totalWaitMs = 0;
    this.chatBuckets.clear();
    this.floodWaitUntil = 0;
    this.globalBucket = new TokenBucket(this.config.globalRate);
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  /**
   * Get or create a per-chat token bucket.
   * Also evicts stale buckets that haven't been used within the TTL.
   */
  private getOrCreateChatBucket(chatId: string): TokenBucket {
    const now = Date.now();

    // Evict stale entries
    const ttl = this.config.chatBucketTtlMs;
    for (const [id, entry] of this.chatBuckets) {
      if (now - entry.lastUsed > ttl) {
        this.chatBuckets.delete(id);
      }
    }

    let entry = this.chatBuckets.get(chatId);
    if (!entry) {
      entry = {
        bucket: new TokenBucket(this.config.perChatRate),
        lastUsed: now,
      };
      this.chatBuckets.set(chatId, entry);
    } else {
      entry.lastUsed = now;
    }

    return entry.bucket;
  }
}
