type SessionEntryReader = {
  getEntries?: () => unknown[];
};

type LiveSessionRegistration = {
  token: symbol;
  readEntries: () => unknown[] | undefined;
};

const LIVE_SESSION_BY_KEY = new Map<string, LiveSessionRegistration>();
const LIVE_SESSION_BY_ID = new Map<string, LiveSessionRegistration>();

function normalizeLookupKey(value: string | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed.toLowerCase() : undefined;
}

function normalizeSessionId(value: string | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

export function registerLiveSessionTranscript(params: {
  sessionKey?: string;
  sessionId?: string;
  sessionReader: SessionEntryReader;
}): () => void {
  const sessionKey = normalizeLookupKey(params.sessionKey);
  const sessionId = normalizeSessionId(params.sessionId);
  const token = Symbol("live-session-transcript");
  const registration: LiveSessionRegistration = {
    token,
    readEntries: () => {
      try {
        const entries = params.sessionReader.getEntries?.();
        return Array.isArray(entries) ? entries.slice() : undefined;
      } catch {
        return undefined;
      }
    },
  };

  if (sessionKey) {
    LIVE_SESSION_BY_KEY.set(sessionKey, registration);
  }
  if (sessionId) {
    LIVE_SESSION_BY_ID.set(sessionId, registration);
  }

  return () => {
    if (sessionKey && LIVE_SESSION_BY_KEY.get(sessionKey)?.token === token) {
      LIVE_SESSION_BY_KEY.delete(sessionKey);
    }
    if (sessionId && LIVE_SESSION_BY_ID.get(sessionId)?.token === token) {
      LIVE_SESSION_BY_ID.delete(sessionId);
    }
  };
}

export function getLiveSessionTranscriptEntries(params: {
  sessionKey?: string;
  sessionId?: string;
}): unknown[] | undefined {
  const sessionKey = normalizeLookupKey(params.sessionKey);
  const sessionId = normalizeSessionId(params.sessionId);
  const registration =
    (sessionKey ? LIVE_SESSION_BY_KEY.get(sessionKey) : undefined) ??
    (sessionId ? LIVE_SESSION_BY_ID.get(sessionId) : undefined);
  return registration?.readEntries();
}

export function resetLiveSessionTranscriptRegistryForTests(): void {
  LIVE_SESSION_BY_KEY.clear();
  LIVE_SESSION_BY_ID.clear();
}
