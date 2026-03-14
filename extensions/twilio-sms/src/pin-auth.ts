const PIN_AUTH_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// In-memory map of senderE164 -> timestamp of last successful PIN auth.
const pinAuthSessions = new Map<string, number>();

export type PinAuthResult =
  | { ok: true; strippedBody: string }
  | { ok: false; reason: "pin_required" };

/**
 * Check if a message passes daily PIN authentication.
 *
 * When PIN auth is enabled, the first message each day must contain the
 * configured PIN (either as the entire body, or as a prefix followed by a
 * space). After successful auth the session is unlocked for 24 hours.
 *
 * The PIN is stripped from the message body before it reaches the agent.
 */
export function checkPinAuth(params: {
  senderE164: string;
  body: string;
  pin: string;
  nowMs?: number;
}): PinAuthResult {
  const now = params.nowMs ?? Date.now();
  const lastAuth = pinAuthSessions.get(params.senderE164);

  // Already authenticated within TTL
  if (lastAuth && now - lastAuth < PIN_AUTH_TTL_MS) {
    return { ok: true, strippedBody: params.body };
  }

  const trimmedBody = params.body.trim();

  // PIN is the entire message
  if (trimmedBody === params.pin) {
    pinAuthSessions.set(params.senderE164, now);
    return { ok: true, strippedBody: "" };
  }

  // PIN is a prefix followed by a space
  if (trimmedBody.startsWith(params.pin + " ")) {
    pinAuthSessions.set(params.senderE164, now);
    return { ok: true, strippedBody: trimmedBody.slice(params.pin.length).trim() };
  }

  return { ok: false, reason: "pin_required" };
}

/** Remove expired sessions to prevent unbounded memory growth. */
export function cleanupExpiredPinSessions(nowMs?: number): void {
  const now = nowMs ?? Date.now();
  for (const [key, ts] of pinAuthSessions) {
    if (now - ts >= PIN_AUTH_TTL_MS) {
      pinAuthSessions.delete(key);
    }
  }
}

/** Reset all sessions (for testing). */
export function _resetPinAuthSessions(): void {
  pinAuthSessions.clear();
}
