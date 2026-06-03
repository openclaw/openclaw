import { NextRequest, NextResponse } from 'next/server';
import { timingSafeEqual } from 'crypto';

/**
 * Dependency-free guards for the fal.ai API routes.
 *
 * Why this exists: the generate/proxy routes spend your FAL_KEY (each image is
 * real money). Without a gate, a deployed URL is an anonymous billing drain.
 *
 *   - rateLimit:    best-effort per-IP throttle (always on)
 *   - requireBearer / isBearerValid: optional shared-secret gate
 *     (enabled by setting GENERATE_API_SECRET)
 *
 * Rate limiting is in-memory: it holds within a warm Fluid Compute instance but
 * is not a cross-instance guarantee. For hard global limits, back `hits` with a
 * shared store (Upstash / Vercel KV).
 */

const WINDOW_MS = 60_000;
const MAX_REQUESTS = 10;
/** Hard backstop so a flood of unique (spoofed) IPs can't grow the Map unbounded. */
const MAX_TRACKED_IPS = 10_000;
const hits = new Map<string, number[]>();
let lastSweep = 0;

export function clientIp(req: NextRequest): string {
  const fwd = req.headers.get('x-forwarded-for');
  if (fwd) return fwd.split(',')[0]!.trim();
  return req.headers.get('x-real-ip') ?? 'unknown';
}

/** Drop entries whose hits have all aged out; runs at most once per window. */
function sweep(now: number, windowMs: number): void {
  if (now - lastSweep < windowMs) return;
  lastSweep = now;
  for (const [ip, times] of hits) {
    if (times.every((t) => now - t >= windowMs)) hits.delete(ip);
  }
}

/** Returns null if allowed, or a 429 response if the caller is over the limit. */
export function rateLimit(
  req: NextRequest,
  max = MAX_REQUESTS,
  windowMs = WINDOW_MS,
): NextResponse | null {
  const ip = clientIp(req);
  const now = Date.now();
  sweep(now, windowMs);

  const recent = (hits.get(ip) ?? []).filter((t) => now - t < windowMs);
  if (recent.length >= max) {
    return NextResponse.json(
      { error: 'Rate limit exceeded. Try again shortly.' },
      { status: 429, headers: { 'Retry-After': String(Math.ceil(windowMs / 1000)) } },
    );
  }
  // Backstop: if the Map is somehow saturated with new IPs, force a sweep; if it
  // is still full, fail closed (429) rather than grow without bound.
  if (!hits.has(ip) && hits.size >= MAX_TRACKED_IPS) {
    lastSweep = 0;
    sweep(now, windowMs);
    if (hits.size >= MAX_TRACKED_IPS) {
      return NextResponse.json(
        { error: 'Server busy. Try again shortly.' },
        { status: 429, headers: { 'Retry-After': String(Math.ceil(windowMs / 1000)) } },
      );
    }
  }
  recent.push(now);
  hits.set(ip, recent);
  return null;
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** True if `authorization` carries the configured `Bearer <GENERATE_API_SECRET>`. */
export function isBearerValid(authorization: string | null | undefined): boolean {
  const secret = process.env.GENERATE_API_SECRET;
  if (!secret) return false;
  const token = authorization?.startsWith('Bearer ') ? authorization.slice(7) : '';
  return safeEqual(token, secret);
}

/**
 * Shared-secret gate for route handlers.
 *   - GENERATE_API_SECRET set        -> requires `Authorization: Bearer <secret>`.
 *   - unset in development           -> no-op (returns null) so local demos work.
 *   - unset in production (incl.     -> fails CLOSED with 503 so a careless deploy
 *     Vercel preview/prod builds)       can't run an anonymous billing drain.
 * Returns null if allowed, or an error response otherwise.
 */
export function requireBearer(req: NextRequest): NextResponse | null {
  if (!process.env.GENERATE_API_SECRET) {
    if (process.env.NODE_ENV === 'production') {
      return NextResponse.json(
        { error: 'Server misconfigured: GENERATE_API_SECRET is required in production.' },
        { status: 503 },
      );
    }
    return null;
  }
  if (isBearerValid(req.headers.get('authorization'))) return null;
  return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
}
