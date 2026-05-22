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
export { acquireSessionWriteLock as n, resolveSessionWriteLockAcquireTimeoutMs as r, SessionWriteLockAcquireTimeoutConfig as t };