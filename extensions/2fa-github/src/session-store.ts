/**
 * Session Store
 *
 * File-based storage for 2FA sessions and pending verifications.
 * Sessions are keyed by sessionKey and include TTL handling.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import type { Session, PendingVerification, SessionStore } from "./types.js";

const STORE_FILENAME = "2fa-sessions.json";

function getStorePath(): string {
  return path.join(os.homedir(), ".clawdbot", STORE_FILENAME);
}

function loadStore(): SessionStore {
  const storePath = getStorePath();

  if (!fs.existsSync(storePath)) {
    return { version: 1, sessions: {}, pending: {} };
  }

  try {
    const data = JSON.parse(fs.readFileSync(storePath, "utf-8"));
    return {
      version: 1,
      sessions: data.sessions ?? {},
      pending: data.pending ?? {},
    };
  } catch {
    // Corrupted file, start fresh
    return { version: 1, sessions: {}, pending: {} };
  }
}

function saveStore(store: SessionStore): void {
  const storePath = getStorePath();
  const dir = path.dirname(storePath);

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  fs.writeFileSync(storePath, JSON.stringify(store, null, 2));
}

/**
 * Prune expired entries from the store.
 */
function pruneExpired(store: SessionStore): void {
  const now = new Date();

  // Prune expired sessions
  for (const [key, session] of Object.entries(store.sessions)) {
    if (new Date(session.expiresAt) < now) {
      delete store.sessions[key];
    }
  }

  // Prune expired pending verifications
  for (const [key, pending] of Object.entries(store.pending)) {
    if (new Date(pending.expiresAt) < now) {
      delete store.pending[key];
    }
  }
}

/**
 * Get a valid session for the given key.
 * Returns undefined if no valid session exists.
 */
export function getSession(sessionKey: string): Session | undefined {
  const store = loadStore();
  const session = store.sessions[sessionKey];

  if (!session) return undefined;

  // Check if expired
  if (new Date(session.expiresAt) < new Date()) {
    delete store.sessions[sessionKey];
    saveStore(store);
    return undefined;
  }

  return session;
}

/**
 * Set a session for the given key.
 * Also clears any pending verification for this key.
 */
export function setSession(sessionKey: string, session: Session): void {
  const store = loadStore();

  // Store the new session
  store.sessions[sessionKey] = session;

  // Clear pending verification on successful auth
  delete store.pending[sessionKey];

  // Prune expired entries
  pruneExpired(store);

  saveStore(store);
}

/**
 * Get a pending verification for the given key.
 * Returns undefined if no valid pending verification exists.
 */
export function getPending(sessionKey: string): PendingVerification | undefined {
  const store = loadStore();
  const pending = store.pending[sessionKey];

  if (!pending) return undefined;

  // Check if expired
  if (new Date(pending.expiresAt) < new Date()) {
    delete store.pending[sessionKey];
    saveStore(store);
    return undefined;
  }

  return pending;
}

/**
 * Set a pending verification for the given key.
 */
export function setPending(sessionKey: string, pending: PendingVerification): void {
  const store = loadStore();
  store.pending[sessionKey] = pending;
  pruneExpired(store);
  saveStore(store);
}

/**
 * Clear a pending verification for the given key.
 */
export function clearPending(sessionKey: string): void {
  const store = loadStore();

  if (store.pending[sessionKey]) {
    delete store.pending[sessionKey];
    saveStore(store);
  }
}

/**
 * Clear all sessions and pending verifications.
 * Useful for testing or manual reset.
 */
export function clearAll(): void {
  const store = { version: 1 as const, sessions: {}, pending: {} };
  saveStore(store);
}

/**
 * Get statistics about the store.
 */
export function getStats(): { sessionCount: number; pendingCount: number } {
  const store = loadStore();
  pruneExpired(store);

  return {
    sessionCount: Object.keys(store.sessions).length,
    pendingCount: Object.keys(store.pending).length,
  };
}
