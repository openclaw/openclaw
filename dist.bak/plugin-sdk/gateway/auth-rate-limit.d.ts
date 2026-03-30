/**
 * In-memory sliding-window rate limiter for gateway authentication attempts.
 *
 * Tracks failed auth attempts by {scope, clientIp}. A scope lets callers keep
 * independent counters for different credential classes (for example, shared
 * gateway token/password vs device-token auth) while still sharing one
 * limiter instance.
 *
 * Design decisions:
 * - Pure in-memory Map – no external dependencies; suitable for a single
 *   gateway process.  The Map is periodically pruned to avoid unbounded
 *   growth.
 * - Loopback addresses (127.0.0.1 / ::1) are exempt by default so that local
 *   CLI sessions are never locked out.
 * - The module is side-effect-free: callers create an instance via
 *   {@link createAuthRateLimiter} and pass it where needed.
 */
export interface RateLimitConfig {
    /** Maximum failed attempts before blocking.  @default 10 */
    maxAttempts?: number;
    /** Sliding window duration in milliseconds.     @default 60_000 (1 min) */
    windowMs?: number;
    /** Lockout duration in milliseconds after the limit is exceeded.  @default 300_000 (5 min) */
    lockoutMs?: number;
    /** Exempt loopback (localhost) addresses from rate limiting.  @default true */
    exemptLoopback?: boolean;
    /** Background prune interval in milliseconds; set <= 0 to disable auto-prune.  @default 60_000 */
    pruneIntervalMs?: number;
}
export declare const AUTH_RATE_LIMIT_SCOPE_DEFAULT = "default";
export declare const AUTH_RATE_LIMIT_SCOPE_SHARED_SECRET = "shared-secret";
export declare const AUTH_RATE_LIMIT_SCOPE_DEVICE_TOKEN = "device-token";
export declare const AUTH_RATE_LIMIT_SCOPE_HOOK_AUTH = "hook-auth";
export interface RateLimitEntry {
    /** Timestamps (epoch ms) of recent failed attempts inside the window. */
    attempts: number[];
    /** If set, requests from this IP are blocked until this epoch-ms instant. */
    lockedUntil?: number;
}
export interface RateLimitCheckResult {
    /** Whether the request is allowed to proceed. */
    allowed: boolean;
    /** Number of remaining attempts before the limit is reached. */
    remaining: number;
    /** Milliseconds until the lockout expires (0 when not locked). */
    retryAfterMs: number;
}
export interface AuthRateLimiter {
    /** Check whether `ip` is currently allowed to attempt authentication. */
    check(ip: string | undefined, scope?: string): RateLimitCheckResult;
    /** Record a failed authentication attempt for `ip`. */
    recordFailure(ip: string | undefined, scope?: string): void;
    /** Reset the rate-limit state for `ip` (e.g. after a successful login). */
    reset(ip: string | undefined, scope?: string): void;
    /** Return the current number of tracked IPs (useful for diagnostics). */
    size(): number;
    /** Remove expired entries and release memory. */
    prune(): void;
    /** Dispose the limiter and cancel periodic cleanup timers. */
    dispose(): void;
}
/**
 * Canonicalize client IPs used for auth throttling so all call sites
 * share one representation (including IPv4-mapped IPv6 forms).
 */
export declare function normalizeRateLimitClientIp(ip: string | undefined): string;
export declare function createAuthRateLimiter(config?: RateLimitConfig): AuthRateLimiter;
