/**
 * Per-sender inbound rate limiter for Telegram channels.
 *
 * Implements a sliding-window counter keyed by sender id, with a separate
 * counter scoped to pairing-policy traffic so a pairing-queue DoS cannot be
 * paid for by exhausting the regular DM budget (or vice versa).
 *
 * Counters are evaluated BEFORE messages reach `messages.queue`, so spam from
 * one sender cannot evict legitimate traffic at the global cap.
 *
 * Tracks issue: https://github.com/openclaw/openclaw/issues/84447
 */

export type TelegramRateLimitDropPolicy = "silent" | "errorReply" | "summary";

export type TelegramRateLimitWindow = {
  /** Sliding window length in seconds (must be > 0). */
  windowSeconds: number;
  /** Max inbound events from a single sender within the window. */
  maxRequests: number;
  /**
   * Optional cooldown applied after a sender exceeds the limit. While the
   * sender is in cooldown all further inbound events are dropped without
   * advancing the window — this is what bounds sustained-flood spend.
   */
  backoffMs?: number;
};

export type TelegramRateLimitConfig = {
  /** Throttle for any inbound DM that has passed prior allow/dm-policy gates. */
  perSender?: TelegramRateLimitWindow & { dropPolicy?: TelegramRateLimitDropPolicy };
  /** Separate counter scoped to pairing-policy attempts (pre-approval). */
  pairing?: TelegramRateLimitWindow & { dropPolicy?: TelegramRateLimitDropPolicy };
  /**
   * Sender ids that bypass both limiters. Each entry MAY include a
   * "telegram:" / "tg:" prefix; bare numeric ids are accepted as well.
   * Owner / allowlist senders are NOT auto-exempted: callers must place
   * them here explicitly so this list is the single source of truth.
   */
  exemptSenderIds?: ReadonlyArray<string | number>;
};

export type RateLimiterDecision =
  | { allowed: true }
  | {
      allowed: false;
      reason: "window";
      retryAfterMs: number;
      dropPolicy: TelegramRateLimitDropPolicy;
    }
  | {
      allowed: false;
      reason: "backoff";
      retryAfterMs: number;
      dropPolicy: TelegramRateLimitDropPolicy;
    };

export type RateLimiterScope = "dm" | "pairing";

type Bucket = {
  /** Monotonic event timestamps (ms since epoch) within the current window. */
  events: number[];
  /** Wall-clock end of an active cooldown, or 0 if not in cooldown. */
  cooldownUntilMs: number;
};

type NormalisedWindow = Required<Pick<TelegramRateLimitWindow, "windowSeconds" | "maxRequests">> & {
  backoffMs: number;
  dropPolicy: TelegramRateLimitDropPolicy;
};

const stripIdPrefix = (raw: string | number): string =>
  String(raw)
    .trim()
    .replace(/^(telegram|tg):/i, "");

const isPositiveInteger = (n: unknown): n is number =>
  typeof n === "number" && Number.isFinite(n) && Number.isInteger(n) && n > 0;

const normaliseWindow = (
  source: (TelegramRateLimitWindow & { dropPolicy?: TelegramRateLimitDropPolicy }) | undefined,
): NormalisedWindow | undefined => {
  if (!source) {
    return undefined;
  }
  if (!isPositiveInteger(source.windowSeconds)) {
    return undefined;
  }
  if (!isPositiveInteger(source.maxRequests)) {
    return undefined;
  }
  const backoff =
    typeof source.backoffMs === "number" &&
    Number.isFinite(source.backoffMs) &&
    source.backoffMs >= 0
      ? Math.floor(source.backoffMs)
      : 0;
  return {
    windowSeconds: source.windowSeconds,
    maxRequests: source.maxRequests,
    backoffMs: backoff,
    dropPolicy: source.dropPolicy ?? "silent",
  };
};

const normaliseExempt = (exemptSenderIds?: ReadonlyArray<string | number>): Set<string> => {
  const out = new Set<string>();
  for (const entry of exemptSenderIds ?? []) {
    const stripped = stripIdPrefix(entry);
    if (/^\d+$/.test(stripped)) {
      out.add(stripped);
    }
  }
  return out;
};

/**
 * Sliding-window per-sender rate limiter. Construct once per Telegram account
 * and call {@link tryConsume} before delivering inbound traffic to the queue.
 *
 * Storage is in-process and bounded by the active-sender count; senders whose
 * buckets fully age out are released on the next call that observes them.
 */
export class TelegramRateLimiter {
  private readonly dmWindow?: NormalisedWindow;
  private readonly pairingWindow?: NormalisedWindow;
  private readonly exempt: Set<string>;
  private readonly buckets = new Map<string, Bucket>();
  private readonly now: () => number;

  constructor(config: TelegramRateLimitConfig | undefined, options?: { now?: () => number }) {
    this.dmWindow = normaliseWindow(config?.perSender);
    this.pairingWindow = normaliseWindow(config?.pairing);
    this.exempt = normaliseExempt(config?.exemptSenderIds);
    this.now = options?.now ?? Date.now;
  }

  /**
   * Returns true when at least one of the configured windows is active.
   * Callers can short-circuit and skip authorization-bypass code paths when
   * the limiter is disabled.
   */
  isEnabled(): boolean {
    return Boolean(this.dmWindow ?? this.pairingWindow);
  }

  /**
   * Returns a non-mutating exemption check. Useful for callers that need to
   * log explicit "exempt sender" decisions before consuming budget.
   */
  isExempt(senderId: string | number | undefined): boolean {
    if (senderId === undefined || senderId === null) {
      return false;
    }
    const stripped = stripIdPrefix(senderId);
    if (!/^\d+$/.test(stripped)) {
      return false;
    }
    return this.exempt.has(stripped);
  }

  /**
   * Consume one budget slot for `senderId` in the given `scope`. When the
   * scope's window is not configured the call is a no-op and returns
   * `{allowed: true}`.
   *
   * Side effects: prunes stale event timestamps for the sender; clears
   * cooldown bookkeeping once it expires.
   */
  tryConsume(senderId: string | number | undefined, scope: RateLimiterScope): RateLimiterDecision {
    const win = scope === "pairing" ? this.pairingWindow : this.dmWindow;
    if (!win) {
      return { allowed: true };
    }
    if (this.isExempt(senderId)) {
      return { allowed: true };
    }

    const id = senderId === undefined ? "" : stripIdPrefix(senderId);
    if (!/^\d+$/.test(id)) {
      // Unknown / non-numeric senders are not trusted to share a bucket with
      // valid ids; deny by default so a malformed Telegram update cannot bypass
      // the limit by omitting `from.id`.
      return {
        allowed: false,
        reason: "window",
        retryAfterMs: win.windowSeconds * 1000,
        dropPolicy: win.dropPolicy,
      };
    }

    const now = this.now();
    const key = `${scope}:${id}`;
    const bucket = this.buckets.get(key) ?? { events: [], cooldownUntilMs: 0 };

    if (bucket.cooldownUntilMs > now) {
      return {
        allowed: false,
        reason: "backoff",
        retryAfterMs: bucket.cooldownUntilMs - now,
        dropPolicy: win.dropPolicy,
      };
    }
    if (bucket.cooldownUntilMs !== 0) {
      bucket.cooldownUntilMs = 0;
    }

    const windowStart = now - win.windowSeconds * 1000;
    // Drop events older than the window. Since `events` is append-only and
    // therefore ordered, splice from the first index whose value is recent.
    let firstRecent = 0;
    while (firstRecent < bucket.events.length && bucket.events[firstRecent] <= windowStart) {
      firstRecent += 1;
    }
    if (firstRecent > 0) {
      bucket.events = bucket.events.slice(firstRecent);
    }

    if (bucket.events.length >= win.maxRequests) {
      if (win.backoffMs > 0) {
        bucket.cooldownUntilMs = now + win.backoffMs;
      }
      this.buckets.set(key, bucket);
      const oldestKept = bucket.events[0] ?? now;
      const retryAfterMs =
        win.backoffMs > 0
          ? win.backoffMs
          : Math.max(1, win.windowSeconds * 1000 - (now - oldestKept));
      return { allowed: false, reason: "window", retryAfterMs, dropPolicy: win.dropPolicy };
    }

    bucket.events.push(now);
    this.buckets.set(key, bucket);
    return { allowed: true };
  }

  /**
   * Drop all in-memory state. Intended for tests and config-reload paths;
   * production callers should reuse the same limiter for the account
   * lifetime so sliding windows stay coherent across runtime restarts of
   * subordinate components.
   */
  reset(): void {
    this.buckets.clear();
  }
}
