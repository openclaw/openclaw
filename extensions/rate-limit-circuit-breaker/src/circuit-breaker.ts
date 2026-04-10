/**
 * Rate Limit Circuit Breaker
 *
 * Tracks consecutive rate-limit error messages per room/channel and suppresses
 * further error deliveries when the circuit is open (tripped). This prevents
 * "death loops" in multi-agent group chats where one agent's rate-limit error
 * triggers other agents to respond, which also hit rate limits, ad infinitum.
 *
 * States:
 *   CLOSED  - normal operation, messages flow through
 *   OPEN    - error messages are suppressed for a cooldown period
 *   HALF_OPEN - after cooldown expires, one retry is allowed; success resets
 *               the breaker, failure re-opens it with doubled cooldown
 */

export type CircuitBreakerConfig = {
  /** Consecutive rate-limit errors before opening the circuit. Default: 3 */
  maxConsecutiveErrors: number;
  /** Base cooldown in ms. Default: 60000 (60s) */
  baseCooldownMs: number;
  /** Maximum cooldown cap in ms. Default: 600000 (10min) */
  maxCooldownMs: number;
};

const DEFAULT_CONFIG: CircuitBreakerConfig = {
  maxConsecutiveErrors: 3,
  baseCooldownMs: 60_000,
  maxCooldownMs: 600_000,
};

type CircuitState = "closed" | "open" | "half_open";

type RoomCircuit = {
  state: CircuitState;
  /** Number of consecutive rate-limit errors observed */
  consecutiveErrors: number;
  /** How many times the circuit has tripped (for exponential backoff) */
  tripCount: number;
  /** When the current open state started (epoch ms) */
  openedAt: number;
  /** Current cooldown duration in ms */
  cooldownMs: number;
};

/**
 * Patterns that identify a rate-limit or overload error message surfaced to chat.
 * These match the messages produced by `formatAssistantErrorText` and
 * `formatRateLimitOrOverloadedErrorCopy` in the OpenClaw core.
 */
const RATE_LIMIT_PATTERNS: RegExp[] = [
  /API rate limit reached/i,
  /rate limit/i,
  /temporarily overloaded/i,
  /LLM request rate limited/i,
  /too many requests/i,
  /429/,
  /rate_limit_exceeded/i,
  /overloaded.*try again/i,
];

const TRANSIENT_ERROR_PATTERNS: RegExp[] = [
  /LLM request timed out/i,
  /request timed out before a response/i,
  /AI service returned an error.*try again/i,
];

export function isRateLimitErrorMessage(content: string): boolean {
  return RATE_LIMIT_PATTERNS.some((re) => re.test(content));
}

export function isTransientErrorMessage(content: string): boolean {
  return (
    isRateLimitErrorMessage(content) ||
    TRANSIENT_ERROR_PATTERNS.some((re) => re.test(content))
  );
}

export class RateLimitCircuitBreaker {
  private rooms = new Map<string, RoomCircuit>();
  private config: CircuitBreakerConfig;
  private logger: { warn: (msg: string) => void; debug?: (msg: string) => void };

  constructor(
    config?: Partial<CircuitBreakerConfig>,
    logger?: { warn: (msg: string) => void; debug?: (msg: string) => void },
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.logger = logger ?? { warn: console.warn };
  }

  /**
   * Build a stable key for a room/channel combination.
   */
  private roomKey(channelId: string, to: string): string {
    return `${channelId}:${to}`;
  }

  private getOrCreate(key: string): RoomCircuit {
    let room = this.rooms.get(key);
    if (!room) {
      room = {
        state: "closed",
        consecutiveErrors: 0,
        tripCount: 0,
        openedAt: 0,
        cooldownMs: this.config.baseCooldownMs,
      };
      this.rooms.set(key, room);
    }
    return room;
  }

  /**
   * Check whether an outgoing message should be suppressed.
   *
   * Called from the `message_sending` hook before each payload delivery.
   * Returns `true` if the message should be cancelled (circuit is open
   * and the message is a rate-limit error).
   */
  shouldSuppress(channelId: string, to: string, content: string): boolean {
    const isError = isRateLimitErrorMessage(content);
    const isTransient = !isError && isTransientErrorMessage(content);
    const key = this.roomKey(channelId, to);
    const room = this.getOrCreate(key);

    if (!isError && !isTransient) {
      // Normal (non-error) message: this counts as a successful interaction.
      // If the circuit was half_open, this confirms recovery.
      if (room.state === "half_open") {
        this.logger.debug?.(
          `[circuit-breaker] ${key}: half_open -> closed (success observed)`,
        );
        room.state = "closed";
        room.consecutiveErrors = 0;
        room.tripCount = 0;
        room.cooldownMs = this.config.baseCooldownMs;
      } else if (room.state === "closed" && room.consecutiveErrors > 0) {
        // Non-error message in closed state: reset the counter
        room.consecutiveErrors = 0;
      }
      return false;
    }

    // It is a rate-limit or transient error message.
    if (room.state === "open") {
      const elapsed = Date.now() - room.openedAt;
      if (elapsed < room.cooldownMs) {
        // Still in cooldown: suppress
        const remainingSec = Math.ceil((room.cooldownMs - elapsed) / 1000);
        this.logger.debug?.(
          `[circuit-breaker] ${key}: OPEN - suppressing error message (${remainingSec}s remaining)`,
        );
        return true;
      }
      // Cooldown expired: transition to half_open, allow one message through
      room.state = "half_open";
      this.logger.warn(
        `[circuit-breaker] ${key}: open -> half_open (cooldown expired, allowing retry)`,
      );
      // Allow this message through so the agent can retry
      return false;
    }

    if (room.state === "half_open") {
      // Another error in half_open: the retry failed. Re-open with increased cooldown.
      room.state = "open";
      room.openedAt = Date.now();
      room.tripCount += 1;
      room.cooldownMs = Math.min(
        room.cooldownMs * 2,
        this.config.maxCooldownMs,
      );
      this.logger.warn(
        `[circuit-breaker] ${key}: half_open -> open (retry failed, cooldown=${room.cooldownMs}ms, trips=${room.tripCount})`,
      );
      return true;
    }

    // state === "closed"
    room.consecutiveErrors += 1;
    if (room.consecutiveErrors >= this.config.maxConsecutiveErrors) {
      // Trip the circuit breaker
      room.state = "open";
      room.openedAt = Date.now();
      room.tripCount += 1;
      // Exponential backoff based on trip count
      room.cooldownMs = Math.min(
        this.config.baseCooldownMs * Math.pow(2, room.tripCount - 1),
        this.config.maxCooldownMs,
      );
      this.logger.warn(
        `[circuit-breaker] ${key}: closed -> open (${room.consecutiveErrors} consecutive errors, cooldown=${room.cooldownMs}ms, trips=${room.tripCount})`,
      );
      return true;
    }

    // Below threshold: let it through
    this.logger.debug?.(
      `[circuit-breaker] ${key}: closed - error ${room.consecutiveErrors}/${this.config.maxConsecutiveErrors}`,
    );
    return false;
  }

  /**
   * Record a successful non-error delivery to a room. Useful for explicit
   * reset from external code (e.g., after a successful agent run).
   */
  recordSuccess(channelId: string, to: string): void {
    const key = this.roomKey(channelId, to);
    const room = this.rooms.get(key);
    if (!room) return;
    room.state = "closed";
    room.consecutiveErrors = 0;
    room.tripCount = 0;
    room.cooldownMs = this.config.baseCooldownMs;
  }

  /** Get the current state for a room (for diagnostics). */
  getState(channelId: string, to: string): RoomCircuit | undefined {
    return this.rooms.get(this.roomKey(channelId, to));
  }

  /** Clean up stale entries older than maxAge ms. */
  cleanup(maxAgeMs: number = 3_600_000): void {
    const now = Date.now();
    for (const [key, room] of this.rooms) {
      if (room.state === "closed" && room.consecutiveErrors === 0) {
        this.rooms.delete(key);
        continue;
      }
      if (room.state === "open" && now - room.openedAt > maxAgeMs) {
        this.rooms.delete(key);
      }
    }
  }
}
