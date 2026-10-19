import { randomUUID } from "node:crypto";
import { resolveIntegerOption } from "@openclaw/normalization-core/number-coercion";
import type { AcpSession } from "./types.js";

export type AcpSessionStore = {
  /** Creates or refreshes an in-memory ACP session under the supplied session id. */
  createSession: (params: {
    sessionKey: string;
    cwd: string;
    sessionId?: string;
    ledgerSessionId?: string;
  }) => AcpSession;
  hasSession: (sessionId: string) => boolean;
  getSession: (sessionId: string) => AcpSession | undefined;
  /**
   * Lists open sessions bound to a gateway session key, most recently
   * touched first. Optional: stores without the lookup simply cannot route
   * prompt-less gateway events (background runs) to an ACP session.
   */
  findSessionsByKey?: (sessionKey: string) => AcpSession[];
  /**
   * Rebinds a session's gateway session key through the store so key-indexed
   * lookups (findSessionsByKey) stay consistent with the authoritative record.
   * Optional: stores without key-indexed lookups can omit it.
   */
  rebindSessionKey?: (sessionId: string, sessionKey: string) => void;
  /** Binds an active runtime run to a session so cancel/close can abort it later. */
  setActiveRun: (sessionId: string, runId: string, abortController: AbortController) => void;
  clearActiveRun: (sessionId: string, expectedRunId?: string) => void;
  cancelActiveRun: (sessionId: string, expectedRunId?: string) => boolean;
  deleteSession: (sessionId: string) => boolean;
};

type InMemoryAcpSessionStore = AcpSessionStore & {
  /** Releases every record when the registry's lifecycle owner shuts down. */
  dispose: () => void;
};

type AcpSessionStoreOptions = {
  maxSessions?: number;
  /**
   * Invoked for every session that leaves the store, whichever path removes it:
   * explicit delete, idle reaping, capacity eviction, or dispose. Consumers that
   * mirror session identity elsewhere use this to stay in step with the store,
   * since eviction and reaping produce no ACP request a peer could observe.
   */
  onSessionRemoved?: (sessionId: string) => void;
};

const DEFAULT_MAX_SESSIONS = 5_000;
const DEFAULT_IDLE_TTL_MS = 24 * 60 * 60 * 1_000;

/** Creates the bounded in-memory ACP session registry used by local ACP runtime clients. */
export function createInMemorySessionStore(
  options: AcpSessionStoreOptions = {},
): InMemoryAcpSessionStore {
  const maxSessions = resolveIntegerOption(options.maxSessions, DEFAULT_MAX_SESSIONS, { min: 1 });
  const onSessionRemoved = options.onSessionRemoved;
  const sessions = new Map<string, AcpSession>();
  const sessionIdsByKeys = new Map<string, Set<string>>();

  const bindSessionKey = (session: AcpSession, previousKey?: string) => {
    if (previousKey && previousKey !== session.sessionKey) {
      const previous = sessionIdsByKeys.get(previousKey);
      previous?.delete(session.sessionId);
      if (previous?.size === 0) {
        sessionIdsByKeys.delete(previousKey);
      }
    }
    let ids = sessionIdsByKeys.get(session.sessionKey);
    if (!ids) {
      ids = new Set();
      sessionIdsByKeys.set(session.sessionKey, ids);
    }
    ids.add(session.sessionId);
  };

  const removeSession = (sessionId: string) => {
    const session = sessions.get(sessionId);
    if (!session) {
      return false;
    }
    const key = session.sessionKey;
    session.abortController?.abort();
    sessions.delete(sessionId);
    const ids = sessionIdsByKeys.get(key);
    ids?.delete(sessionId);
    if (ids?.size === 0) {
      sessionIdsByKeys.delete(key);
    }
    onSessionRemoved?.(sessionId);
    return true;
  };

  const reapIdleSessions = (nowMs: number) => {
    const idleBefore = nowMs - DEFAULT_IDLE_TTL_MS;
    for (const [sessionId, session] of sessions.entries()) {
      if (session.activeRunId || session.abortController) {
        continue;
      }
      if (session.lastTouchedAt > idleBefore) {
        continue;
      }
      removeSession(sessionId);
    }
  };

  const evictOldestIdleSession = () => {
    let oldestSessionId: string | null = null;
    let oldestLastTouchedAt = Number.POSITIVE_INFINITY;
    for (const [sessionId, session] of sessions.entries()) {
      if (session.activeRunId || session.abortController) {
        continue;
      }
      if (session.lastTouchedAt >= oldestLastTouchedAt) {
        continue;
      }
      oldestLastTouchedAt = session.lastTouchedAt;
      oldestSessionId = sessionId;
    }
    if (!oldestSessionId) {
      return false;
    }
    return removeSession(oldestSessionId);
  };

  const releaseActiveRun = (session: AcpSession) => {
    session.activeRunId = null;
    session.abortController = null;
    session.lastTouchedAt = Date.now();
  };

  return {
    createSession(params) {
      const nowMs = Date.now();
      const sessionId = params.sessionId ?? randomUUID();
      const existingSession = sessions.get(sessionId);
      if (existingSession) {
        const previousKey = existingSession.sessionKey;
        existingSession.sessionKey = params.sessionKey;
        if ("ledgerSessionId" in params) {
          existingSession.ledgerSessionId = params.ledgerSessionId;
        }
        existingSession.cwd = params.cwd;
        existingSession.lastTouchedAt = nowMs;
        bindSessionKey(existingSession, previousKey);
        return existingSession;
      }
      reapIdleSessions(nowMs);
      // Active runs are never evicted to make cancellation ownership explicit; callers must
      // clear/cancel them before the soft cap can make room.
      if (sessions.size >= maxSessions && !evictOldestIdleSession()) {
        throw new Error(
          `ACP session limit reached (max ${maxSessions}). Close idle ACP clients and retry.`,
        );
      }
      const session: AcpSession = {
        sessionId,
        sessionKey: params.sessionKey,
        ...(params.ledgerSessionId ? { ledgerSessionId: params.ledgerSessionId } : {}),
        cwd: params.cwd,
        createdAt: nowMs,
        lastTouchedAt: nowMs,
        abortController: null,
        activeRunId: null,
      };
      sessions.set(sessionId, session);
      bindSessionKey(session);
      return session;
    },
    hasSession: (sessionId) => sessions.has(sessionId),
    rebindSessionKey(sessionId, sessionKey) {
      const session = sessions.get(sessionId);
      if (!session || session.sessionKey === sessionKey) {
        return;
      }
      const previousKey = session.sessionKey;
      session.sessionKey = sessionKey;
      bindSessionKey(session, previousKey);
    },
    getSession(sessionId) {
      const session = sessions.get(sessionId);
      if (session) {
        session.lastTouchedAt = Date.now();
      }
      return session;
    },
    findSessionsByKey(sessionKey) {
      const ids = sessionIdsByKeys.get(sessionKey);
      if (!ids?.size) {
        return [];
      }
      const matches: AcpSession[] = [];
      for (const sessionId of ids) {
        const session = sessions.get(sessionId);
        if (session) {
          matches.push(session);
        }
      }
      matches.sort((left, right) => right.lastTouchedAt - left.lastTouchedAt);
      return matches;
    },
    setActiveRun(sessionId, runId, abortController) {
      const session = sessions.get(sessionId);
      if (!session) {
        return;
      }
      session.activeRunId = runId;
      session.abortController = abortController;
      session.lastTouchedAt = Date.now();
    },
    clearActiveRun(sessionId, expectedRunId) {
      const session = sessions.get(sessionId);
      if (session && (expectedRunId === undefined || session.activeRunId === expectedRunId)) {
        releaseActiveRun(session);
      }
    },
    cancelActiveRun(sessionId, expectedRunId) {
      const session = sessions.get(sessionId);
      if (
        !session?.abortController ||
        (expectedRunId !== undefined && session.activeRunId !== expectedRunId)
      ) {
        return false;
      }
      session.abortController.abort();
      releaseActiveRun(session);
      return true;
    },
    deleteSession: removeSession,
    dispose() {
      for (const session of sessions.values()) {
        session.abortController?.abort();
      }
      const removed = [...sessions.keys()];
      sessions.clear();
      sessionIdsByKeys.clear();
      for (const sessionId of removed) {
        onSessionRemoved?.(sessionId);
      }
    },
  };
}
