import type { IncomingMessage, ServerResponse } from "node:http";
import crypto from "node:crypto";

// --- Token TTL (24h) ---
const MAX_ACTIVE_TOKENS = 200;
const activeTokens = new Map<string, number>(); // token → expiresAt
const TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24h

/** Lazily evict a batch of expired tokens (called on each auth check). */
function evictExpiredTokens() {
  const now = Date.now();
  let cleaned = 0;
  for (const [token, exp] of activeTokens) {
    if (cleaned >= 20) {
      break;
    }
    if (now > exp) {
      activeTokens.delete(token);
      cleaned++;
    }
  }
}

/** Extract bearer token from Authorization header. */
export function extractBearerToken(req: IncomingMessage): string | null {
  const auth = req.headers.authorization;
  if (!auth?.startsWith("Bearer ")) {
    return null;
  }
  return auth.slice(7);
}

/** Check bearer token with TTL expiration. */
export function checkAuth(req: IncomingMessage): boolean {
  const token = extractBearerToken(req);
  if (!token) {
    return false;
  }
  const expiresAt = activeTokens.get(token);
  if (!expiresAt) {
    return false;
  }
  if (Date.now() > expiresAt) {
    activeTokens.delete(token);
    return false;
  }
  // Lazily clean up expired tokens on each successful auth check
  evictExpiredTokens();
  return true;
}

/** Issue a new session token (256-bit), evicting the oldest if at capacity. */
export function issueSessionToken(): string {
  if (activeTokens.size >= MAX_ACTIVE_TOKENS) {
    let oldestKey: string | null = null;
    let oldestExp = Infinity;
    for (const [k, v] of activeTokens) {
      if (v < oldestExp) {
        oldestExp = v;
        oldestKey = k;
      }
    }
    if (oldestKey) {
      activeTokens.delete(oldestKey);
    }
  }

  const sessionToken = crypto.randomBytes(32).toString("hex");
  activeTokens.set(sessionToken, Date.now() + TOKEN_TTL_MS);
  return sessionToken;
}

/** Truncate token for logging (first 8 chars). */
export function tokenTag(req: IncomingMessage): string {
  const t = extractBearerToken(req);
  return t ? t.slice(0, 8) + "..." : "unknown";
}

/** Send a JSON response with standard security headers. */
export function jsonResponse(
  res: ServerResponse,
  status: number,
  data: unknown,
  corsOrigin: string,
) {
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Access-Control-Allow-Origin", corsOrigin);
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.statusCode = status;
  res.end(JSON.stringify(data));
}

/** Read a JSON body from an IncomingMessage. */
export function readJsonBody(
  req: IncomingMessage,
  maxBytes = 5 * 1024 * 1024,
): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    req.on("data", (chunk: Buffer) => {
      if (settled) {
        return;
      }
      size += chunk.length;
      if (size > maxBytes) {
        settled = true;
        resolve(null);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (settled) {
        return;
      }
      settled = true;
      try {
        const text = Buffer.concat(chunks).toString("utf-8");
        resolve(JSON.parse(text) as Record<string, unknown>);
      } catch {
        resolve(null);
      }
    });
    req.on("error", () => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(null);
    });
  });
}
