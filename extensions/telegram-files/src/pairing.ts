import crypto from "node:crypto";

const store = new Map<string, { expiresAt: number }>();
const TTL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_PAIRING_CODES = 100;

function evictExpired(): void {
  const now = Date.now();
  for (const [key, entry] of store) {
    if (entry.expiresAt <= now) {
      store.delete(key);
    }
  }
}

/** Create a one-time pairing code. */
export function createPairingCode(): string {
  evictExpired();

  // Evict oldest if at capacity
  if (store.size >= MAX_PAIRING_CODES) {
    let oldestKey: string | null = null;
    let oldestTime = Infinity;
    for (const [key, entry] of store) {
      if (entry.expiresAt < oldestTime) {
        oldestTime = entry.expiresAt;
        oldestKey = key;
      }
    }
    if (oldestKey) {
      store.delete(oldestKey);
    }
  }

  const code = crypto.randomBytes(32).toString("hex");
  store.set(code, { expiresAt: Date.now() + TTL_MS });
  return code;
}

/** Exchange a pairing code. One-time use. Returns true if valid. */
export function exchangePairingCode(code: string): boolean {
  evictExpired();
  const entry = store.get(code);
  if (!entry) {
    return false;
  }
  store.delete(code);
  return true;
}
