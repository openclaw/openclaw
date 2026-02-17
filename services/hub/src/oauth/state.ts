import { createHmac, randomBytes } from "node:crypto";

const STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes

const pending = new Map<string, number>();

function sign(value: string, secret: string): string {
  return createHmac("sha256", secret).update(value).digest("hex");
}

/**
 * State format: `{nonce}.{instanceId}.{signature}`
 * where signature = HMAC-SHA256(secret, "nonce|instanceId")
 */
export function generateState(secret: string, instanceId: string): string {
  const nonce = randomBytes(16).toString("hex");
  const signature = sign(`${nonce}|${instanceId}`, secret);
  const state = `${nonce}.${instanceId}.${signature}`;
  pending.set(state, Date.now());
  return state;
}

/**
 * Returns the embedded `instanceId` on success, or `null` on failure.
 */
export function consumeState(state: string, secret: string): string | null {
  const parts = state.split(".");
  if (parts.length !== 3) {
    return null;
  }

  const [nonce, instanceId, providedSig] = parts;
  const expectedSig = sign(`${nonce}|${instanceId}`, secret);

  if (providedSig !== expectedSig) {
    return null;
  }

  const createdAt = pending.get(state);
  if (createdAt === undefined) {
    return null;
  }

  pending.delete(state);

  if (Date.now() - createdAt > STATE_TTL_MS) {
    return null;
  }

  return instanceId;
}

// Periodic cleanup of expired entries
setInterval(() => {
  const now = Date.now();
  for (const [key, createdAt] of pending) {
    if (now - createdAt > STATE_TTL_MS) {
      pending.delete(key);
    }
  }
}, 60_000).unref();
