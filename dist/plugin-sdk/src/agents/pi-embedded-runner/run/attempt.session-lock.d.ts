import type { acquireSessionWriteLock } from "../../session-write-lock.js";
type SessionLock = Awaited<ReturnType<typeof acquireSessionWriteLock>>;
type AcquireSessionWriteLock = typeof acquireSessionWriteLock;
type LockOptions = {
    sessionFile: string;
    timeoutMs: number;
    staleMs: number;
    maxHoldMs: number;
};
type SessionWriteLockRunOptions = {
    publishOwnedWrite?: boolean;
};
export declare class EmbeddedAttemptSessionTakeoverError extends Error {
    constructor(sessionFile: string);
}
export declare function installSessionEventWriteLock(params: {
    session: unknown;
    withSessionWriteLock: <T>(run: () => Promise<T> | T) => Promise<T>;
}): void;
export declare function installSessionExternalHookWriteLock(params: {
    session: unknown;
    withSessionWriteLock: <T>(run: () => Promise<T> | T) => Promise<T>;
}): void;
export type EmbeddedAttemptSessionLockController = {
    releaseForPrompt(): Promise<void>;
    refreshAfterOwnedSessionWrite(): void;
    reacquireAfterPrompt(): Promise<void>;
    waitForSessionEvents(session: unknown): Promise<void>;
    withSessionWriteLock<T>(run: () => Promise<T> | T, options?: SessionWriteLockRunOptions): Promise<T>;
    acquireForCleanup(params?: {
        session?: unknown;
    }): Promise<SessionLock>;
    hasSessionTakeover(): boolean;
};
export declare function createEmbeddedAttemptSessionLockController(params: {
    acquireSessionWriteLock: AcquireSessionWriteLock;
    lockOptions: LockOptions;
}): Promise<EmbeddedAttemptSessionLockController>;
export declare function installPromptSubmissionLockRelease(params: {
    session: unknown;
    waitForSessionEvents: (session: unknown) => Promise<void>;
    releaseForPrompt: () => Promise<void>;
    reacquireAfterPrompt: () => Promise<void>;
    sessionFile?: string;
    sessionKey?: string;
    withSessionWriteLock?: <T>(run: () => Promise<T> | T, options?: SessionWriteLockRunOptions) => Promise<T>;
}): void;
export {};
