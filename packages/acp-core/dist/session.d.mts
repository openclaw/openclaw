import { AcpSession } from "./types.mjs";

//#region src/session.d.ts
type AcpSessionStore = {
  createSession: (params: {
    sessionKey: string;
    cwd: string;
    sessionId?: string;
    ledgerSessionId?: string;
  }) => AcpSession;
  hasSession: (sessionId: string) => boolean;
  getSession: (sessionId: string) => AcpSession | undefined;
  getSessionByRunId: (runId: string) => AcpSession | undefined;
  setActiveRun: (sessionId: string, runId: string, abortController: AbortController) => void;
  clearActiveRun: (sessionId: string) => void;
  cancelActiveRun: (sessionId: string) => boolean;
  deleteSession: (sessionId: string) => boolean;
  clearAllSessionsForTest: () => void;
};
type AcpSessionStoreOptions = {
  maxSessions?: number;
  idleTtlMs?: number;
  now?: () => number;
};
declare function createInMemorySessionStore(options?: AcpSessionStoreOptions): AcpSessionStore;
declare const defaultAcpSessionStore: AcpSessionStore;
//#endregion
export { AcpSessionStore, createInMemorySessionStore, defaultAcpSessionStore };