import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AcpSession } from "./types.js";

export type AcpSessionStore = {
  createSession: (params: { sessionKey: string; cwd: string; sessionId?: string }) => AcpSession;
  getSession: (sessionId: string) => AcpSession | undefined;
  getSessionByRunId: (runId: string) => AcpSession | undefined;
  setActiveRun: (sessionId: string, runId: string, abortController: AbortController) => void;
  clearActiveRun: (sessionId: string) => void;
  cancelActiveRun: (sessionId: string) => boolean;
  clearAllSessionsForTest: () => void;
};

export function createInMemorySessionStore(): AcpSessionStore {
  const sessions = new Map<string, AcpSession>();
  const runIdToSessionId = new Map<string, string>();

  const createSession: AcpSessionStore["createSession"] = (params) => {
    const sessionId = params.sessionId ?? randomUUID();
    const session: AcpSession = {
      sessionId,
      sessionKey: params.sessionKey,
      cwd: params.cwd,
      createdAt: Date.now(),
      abortController: null,
      activeRunId: null,
    };
    sessions.set(sessionId, session);
    return session;
  };

  const getSession: AcpSessionStore["getSession"] = (sessionId) => sessions.get(sessionId);

  const getSessionByRunId: AcpSessionStore["getSessionByRunId"] = (runId) => {
    const sessionId = runIdToSessionId.get(runId);
    return sessionId ? sessions.get(sessionId) : undefined;
  };

  const setActiveRun: AcpSessionStore["setActiveRun"] = (sessionId, runId, abortController) => {
    const session = sessions.get(sessionId);
    if (!session) {
      return;
    }
    session.activeRunId = runId;
    session.abortController = abortController;
    runIdToSessionId.set(runId, sessionId);
  };

  const clearActiveRun: AcpSessionStore["clearActiveRun"] = (sessionId) => {
    const session = sessions.get(sessionId);
    if (!session) {
      return;
    }
    if (session.activeRunId) {
      runIdToSessionId.delete(session.activeRunId);
    }
    session.activeRunId = null;
    session.abortController = null;
  };

  const cancelActiveRun: AcpSessionStore["cancelActiveRun"] = (sessionId) => {
    const session = sessions.get(sessionId);
    if (!session?.abortController) {
      return false;
    }
    session.abortController.abort();
    if (session.activeRunId) {
      runIdToSessionId.delete(session.activeRunId);
    }
    session.abortController = null;
    session.activeRunId = null;
    return true;
  };

  const clearAllSessionsForTest: AcpSessionStore["clearAllSessionsForTest"] = () => {
    for (const session of sessions.values()) {
      session.abortController?.abort();
    }
    sessions.clear();
    runIdToSessionId.clear();
  };

  return {
    createSession,
    getSession,
    getSessionByRunId,
    setActiveRun,
    clearActiveRun,
    cancelActiveRun,
    clearAllSessionsForTest,
    /** Return all sessions for persistence (internal use) */
    _getAllSessions: () => Record<string, AcpSession>,
  };
}

/**
 * File-backed session store for ACP persistence across process restarts.
 * Sessions are stored in ~/.openclaw/acp-sessions.json
 */
export function createFileSessionStore(): AcpSessionStore {
  const memoryStore = createInMemorySessionStore();
  const sessionFile = path.join(
    process.env.OPENCLAW_STATE_DIR || path.join(os.homedir() || "", ".openclaw"),
    "acp-sessions.json",
  );
  let saveTimeout: ReturnType<typeof setTimeout> | null = null;
  let loaded = false;

  const loadFromDisk = () => {
    if (loaded) {
      return;
    }
    loaded = true;
    try {
      if (fs.existsSync(sessionFile)) {
        const data = JSON.parse(fs.readFileSync(sessionFile, "utf8"));
        for (const [sessionId, sessionData] of Object.entries(data)) {
          try {
            memoryStore.createSession({
              sessionId,
              sessionKey: sessionData.sessionKey,
              cwd: sessionData.cwd,
            });
          } catch {
            // ignore individual session errors
          }
        }
      }
    } catch {
      // ignore load errors
    }
  };

  const saveToDisk = () => {
    if (saveTimeout) {
      return;
    }
    saveTimeout = setTimeout(() => {
      saveTimeout = null;
      try {
        const sessions = memoryStore._getAllSessions?.() || {};
        fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
        fs.writeFileSync(sessionFile, JSON.stringify(sessions, null, 2), "utf8");
      } catch {
        // ignore save errors
      }
    }, 1000);
  };

  // Load existing sessions on startup
  loadFromDisk();

  return {
    createSession: (params) => {
      const s = memoryStore.createSession(params);
      saveToDisk();
      return s;
    },
    getSession: (id) => {
      loadFromDisk();
      return memoryStore.getSession(id);
    },
    getSessionByRunId: (id) => memoryStore.getSessionByRunId(id),
    setActiveRun: (sid, rid, ac) => {
      memoryStore.setActiveRun(sid, rid, ac);
      saveToDisk();
    },
    clearActiveRun: (sid) => {
      memoryStore.clearActiveRun(sid);
      saveToDisk();
    },
    cancelActiveRun: (sid) => {
      const r = memoryStore.cancelActiveRun(sid);
      saveToDisk();
      return r;
    },
    clearAllSessionsForTest: () => {
      memoryStore.clearAllSessionsForTest();
      saveToDisk();
    },
  };
}

export const defaultAcpSessionStore = createFileSessionStore();
