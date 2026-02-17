import { randomBytes } from "node:crypto";

const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

const sessions = new Map<string, number>();

export function createSession(): string {
  const token = randomBytes(32).toString("hex");
  sessions.set(token, Date.now());
  return token;
}

export function validateSession(token: string): boolean {
  const createdAt = sessions.get(token);
  if (createdAt === undefined) {
    return false;
  }
  if (Date.now() - createdAt > SESSION_TTL_MS) {
    sessions.delete(token);
    return false;
  }
  return true;
}

export function destroySession(token: string): void {
  sessions.delete(token);
}

// Periodic cleanup of expired sessions
setInterval(() => {
  const now = Date.now();
  for (const [token, createdAt] of sessions) {
    if (now - createdAt > SESSION_TTL_MS) {
      sessions.delete(token);
    }
  }
}, 60_000).unref();
