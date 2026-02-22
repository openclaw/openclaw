import { NextRequest, NextResponse } from "next/server";
import { apiErrorResponse, attachRequestIdHeader } from "@/lib/errors";

/**
 * Persistent rate limiter backed by SQLite.
 * Rate limit state survives server restarts (AA+ resilience).
 *
 * Uses lazy require() for db.ts to avoid circular imports at module load.
 */

export interface RateLimitConfig {
  /** Maximum requests allowed in the window */
  limit: number;
  /** Time window in seconds */
  windowSec: number;
  /** Key extractor (defaults to IP address) */
  keyFn?: (request: NextRequest) => string;
}

const DEFAULT_CONFIG: RateLimitConfig = {
  limit: 100,
  windowSec: 60,
};

const RATE_LIMIT_ENABLED =
  (process.env.MISSION_CONTROL_RATE_LIMIT_ENABLED ?? "true") === "true";

// Cleanup expired entries every 60 seconds (not every request — keeps it fast)
const CLEANUP_INTERVAL_MS = 60_000;
let lastCleanup = Date.now();

/**
 * Lazily get the database instance to avoid circular imports.
 * rate-limit.ts is imported by api-guard.ts which may load before db.ts.
 */
function getDbLazy() {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { getDb } = require("./db") as {
    getDb: () => import("better-sqlite3").Database;
  };
  return getDb();
}

/** Purge expired rate limit entries from the database. */
function cleanupExpired(): void {
  const now = Date.now();
  if (now - lastCleanup < CLEANUP_INTERVAL_MS) {return;}
  lastCleanup = now;

  try {
    getDbLazy().prepare("DELETE FROM rate_limits WHERE reset_at < ?").run(now);
  } catch {
    // DB may not be ready yet (startup / build-time) — silently skip
  }
}

/**
 * Get client identifier for rate limiting.
 * Uses X-Forwarded-For for proxied requests, falls back to unknown.
 */
function getClientKey(request: NextRequest): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    return forwarded.split(",")[0].trim();
  }
  const realIp = request.headers.get("x-real-ip");
  if (realIp) {
    return realIp;
  }
  return "unknown";
}

/**
 * Check rate limit and return error response if exceeded.
 * Returns null if request is allowed.
 *
 * Rate limit state is persisted in SQLite so it survives restarts.
 */
export function checkRateLimit(
  request: NextRequest,
  config: Partial<RateLimitConfig> = {},
  requestId?: string
): NextResponse | null {
  if (!RATE_LIMIT_ENABLED) {return null;}

  cleanupExpired();

  const { limit, windowSec, keyFn } = { ...DEFAULT_CONFIG, ...config };
  const baseKey = keyFn ? keyFn(request) : getClientKey(request);
  // Scope limits per route+method so one noisy panel does not starve all APIs.
  const key = `${request.method}:${request.nextUrl.pathname}:${baseKey}`;
  const now = Date.now();
  const windowMs = windowSec * 1000;

  try {
    const db = getDbLazy();

    const entry = db
      .prepare("SELECT count, reset_at FROM rate_limits WHERE key = ?")
      .get(key) as { count: number; reset_at: number } | undefined;

    if (!entry || entry.reset_at < now) {
      // New window — upsert
      db.prepare(
        `INSERT INTO rate_limits (key, count, reset_at) VALUES (?, 1, ?)
         ON CONFLICT(key) DO UPDATE SET count = 1, reset_at = excluded.reset_at`
      ).run(key, now + windowMs);
      return null;
    }

    if (entry.count >= limit) {
      const retryAfter = Math.ceil((entry.reset_at - now) / 1000);
      return apiErrorResponse({
        message: "Too many requests. Please slow down.",
        status: 429,
        code: "RATE_LIMITED",
        requestId,
        headers: {
          "Retry-After": String(retryAfter),
          "X-RateLimit-Limit": String(limit),
          "X-RateLimit-Remaining": "0",
          "X-RateLimit-Reset": String(entry.reset_at),
        },
      });
    }

    // Increment count
    db.prepare("UPDATE rate_limits SET count = count + 1 WHERE key = ?").run(
      key
    );
    return null;
  } catch {
    // If DB is unavailable (startup, build-time), allow the request through
    return null;
  }
}

/**
 * Rate limit presets for different endpoint types.
 */
export const RateLimitPresets = {
  /** Standard API calls: 100/min */
  standard: { limit: 100, windowSec: 60 },
  /** Expensive operations: 20/min */
  expensive: { limit: 20, windowSec: 60 },
  /** Write operations: 30/min */
  write: { limit: 30, windowSec: 60 },
  /** Chat/LLM operations: 10/min */
  llm: { limit: 10, windowSec: 60 },
  /** Auth attempts: 5/min */
  auth: { limit: 5, windowSec: 60 },
};

/**
 * Wrap an API handler with rate limiting.
 * Usage:
 *   export const POST = withRateLimit(handler, RateLimitPresets.write);
 */
export function withRateLimit(
  handler: (request: NextRequest) => Promise<NextResponse>,
  config: Partial<RateLimitConfig> = {}
): (request: NextRequest) => Promise<NextResponse> {
  return async (request: NextRequest) => {
    const requestId = request.headers.get("x-request-id") ?? undefined;
    const rateLimitError = checkRateLimit(request, config, requestId);
    if (rateLimitError) {return rateLimitError;}
    const response = await handler(request);
    return attachRequestIdHeader(response, requestId);
  };
}
