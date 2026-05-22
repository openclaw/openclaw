export declare class SessionWriteLockTimeoutError extends Error {
    readonly code = "OPENCLAW_SESSION_WRITE_LOCK_TIMEOUT";
    readonly timeoutMs: number;
    readonly owner: string;
    readonly lockPath: string;
    constructor(params: {
        timeoutMs: number;
        owner: string;
        lockPath: string;
    });
}
export declare function isSessionWriteLockTimeoutError(err: unknown): boolean;
