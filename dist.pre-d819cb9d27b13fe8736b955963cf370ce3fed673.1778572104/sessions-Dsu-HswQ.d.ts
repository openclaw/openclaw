import { SessionManager } from "@earendil-works/pi-coding-agent";

//#region src/config/sessions/artifacts.d.ts
declare function isSessionArchiveArtifactName(fileName: string): boolean;
declare function isUsageCountedSessionTranscriptFileName(fileName: string): boolean;
declare function parseUsageCountedSessionIdFromFileName(fileName: string): string | null;
//#endregion
//#region src/agents/session-write-lock.d.ts
type SessionWriteLockAcquireTimeoutConfig = {
  session?: {
    writeLock?: {
      acquireTimeoutMs?: number;
    };
  };
};
declare function resolveSessionWriteLockAcquireTimeoutMs(config?: SessionWriteLockAcquireTimeoutConfig): number;
declare function acquireSessionWriteLock(params: {
  sessionFile: string;
  timeoutMs?: number;
  staleMs?: number;
  maxHoldMs?: number;
  allowReentrant?: boolean;
}): Promise<{
  release: () => Promise<void>;
}>;
//#endregion
export { isUsageCountedSessionTranscriptFileName as a, isSessionArchiveArtifactName as i, acquireSessionWriteLock as n, parseUsageCountedSessionIdFromFileName as o, resolveSessionWriteLockAcquireTimeoutMs as r, SessionWriteLockAcquireTimeoutConfig as t };