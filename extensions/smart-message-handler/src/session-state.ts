import type { SessionState } from "./types.ts";

const INTERNAL = Symbol("session-store-internal");

interface InternalData {
  readonly sessions: Map<string, SessionState>;
  readonly maxSessions: number;
}

export interface SessionStore {
  readonly size: number;
  /** @internal */
  readonly [INTERNAL]: InternalData;
}

function createStoreFromMap(
  sessions: Map<string, SessionState>,
  maxSessions: number,
): SessionStore {
  return {
    get size() {
      return sessions.size;
    },
    [INTERNAL]: { sessions, maxSessions },
  };
}

export function createSessionStore(maxSessions = 100): SessionStore {
  return createStoreFromMap(new Map(), maxSessions);
}

export function recordMessage(store: SessionStore, sessionKey: string): SessionStore {
  const { sessions: prevSessions, maxSessions } = store[INTERNAL];
  const now = Date.now();
  const sessions = new Map(prevSessions); // shallow clone

  const prev = sessions.get(sessionKey);
  if (prev) {
    const interval = now - prev.lastMessageTime;
    const trackInterval = interval < 30_000;
    const newTotalIntervals = trackInterval ? prev.totalIntervals + 1 : prev.totalIntervals;
    const newAvgInterval = trackInterval
      ? (prev.avgInterval * prev.totalIntervals + interval) / newTotalIntervals
      : prev.avgInterval;
    sessions.set(sessionKey, {
      lastMessageTime: now,
      messageCount: prev.messageCount + 1,
      avgInterval: newAvgInterval,
      totalIntervals: newTotalIntervals,
    });
  } else {
    sessions.set(sessionKey, {
      lastMessageTime: now,
      messageCount: 1,
      avgInterval: 0,
      totalIntervals: 0,
    });
  }

  // LRU eviction: evict oldest lastMessageTime
  if (sessions.size > maxSessions) {
    let oldestKey: string | undefined;
    let oldestTime = Infinity;
    for (const [key, state] of sessions) {
      if (state.lastMessageTime < oldestTime) {
        oldestTime = state.lastMessageTime;
        oldestKey = key;
      }
    }
    if (oldestKey !== undefined) {
      sessions.delete(oldestKey);
    }
  }

  return createStoreFromMap(sessions, maxSessions);
}

export function getSession(store: SessionStore, sessionKey: string): SessionState | undefined {
  return store[INTERNAL].sessions.get(sessionKey);
}

export function clearSessions(store: SessionStore): SessionStore {
  return createSessionStore(store[INTERNAL].maxSessions);
}
