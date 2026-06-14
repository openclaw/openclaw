import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { persistSessionEntry } from "./attempt-execution.shared.js";
import { resolveSession, type SessionResolution } from "./session.js";

// Per-session-key serialization for resolving a brand-new session identity.
//
// Concurrent commands that target the same session key must agree on a single
// `sessionId`. `resolveSession` mints a fresh `crypto.randomUUID()` whenever the
// key has no fresh stored entry, and that resolution runs before the per-session
// execution lane is entered (the lane is keyed by session key but only
// serializes execution). Two requests that race here -- e.g. a follow-up sent
// while the first turn is still in flight on the OpenAI-compatible endpoint --
// each mint their own id, so the later one runs in an isolated, memory-less
// session. Serializing the mint-and-reserve step closes that window: the first
// request persists the key-to-id mapping and any concurrent request adopts it
// instead of forking a second session.
const SESSION_RESERVATION_QUEUE = new Map<string, Promise<unknown>>();

async function serializeReservation<T>(key: string, task: () => Promise<T>): Promise<T> {
  const prev = SESSION_RESERVATION_QUEUE.get(key) ?? Promise.resolve();
  const next = prev.then(task, task);
  SESSION_RESERVATION_QUEUE.set(key, next);
  try {
    return await next;
  } finally {
    if (SESSION_RESERVATION_QUEUE.get(key) === next) {
      SESSION_RESERVATION_QUEUE.delete(key);
    }
  }
}

export type ResolveSessionInput = {
  cfg: OpenClawConfig;
  to?: string;
  sessionId?: string;
  sessionKey?: string;
  agentId?: string;
  clone?: boolean;
  /**
   * Internal handoffs (sessionEffects === "internal") must not write visible
   * session-store rows. Skip the reservation persist entirely; internal runs
   * are orchestrated, not user-fired, so there is no same-key race to protect.
   */
  suppressVisibleSessionEffects?: boolean;
};

/**
 * Resolve a session like {@link resolveSession}, but serialize the brand-new
 * session path per session key so concurrent commands cannot fork separate
 * sessions for the same key.
 */
export async function resolveSessionWithReservation(
  opts: ResolveSessionInput,
): Promise<SessionResolution> {
  const resolution = resolveSession(opts);
  // Only a brand-new session mints a random id and is therefore racy. An
  // explicit session id or an existing fresh entry already pins the identity,
  // so those paths skip the lock entirely and keep steady-state turns lock-free.
  // Internal handoffs also skip reservation so they cannot create a visible
  // session-store row that the suppressVisibleSessionEffects contract forbids.
  if (
    opts.suppressVisibleSessionEffects ||
    opts.sessionId?.trim() ||
    !resolution.isNewSession ||
    !resolution.sessionKey
  ) {
    return resolution;
  }
  const reservationKey = `${resolution.storePath}::${resolution.sessionKey}`;
  return await serializeReservation(reservationKey, async () => {
    // Re-resolve inside the critical section: a concurrent command may have
    // reserved an id between the initial resolve and acquiring the lock.
    const rechecked = resolveSession(opts);
    if (!rechecked.isNewSession || !rechecked.sessionKey || !rechecked.sessionStore) {
      return rechecked;
    }
    const now = Date.now();
    await persistSessionEntry({
      sessionStore: rechecked.sessionStore,
      sessionKey: rechecked.sessionKey,
      storePath: rechecked.storePath,
      entry: { sessionId: rechecked.sessionId, updatedAt: now, sessionStartedAt: now },
    });
    return rechecked;
  });
}
