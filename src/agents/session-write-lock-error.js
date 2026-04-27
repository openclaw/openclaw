export const SESSION_WRITE_LOCK_TIMEOUT_CODE = "OPENCLAW_SESSION_WRITE_LOCK_TIMEOUT";
export class SessionWriteLockTimeoutError extends Error {
    code = SESSION_WRITE_LOCK_TIMEOUT_CODE;
    timeoutMs;
    owner;
    lockPath;
    constructor(params) {
        super(`session file locked (timeout ${params.timeoutMs}ms): ${params.owner} ${params.lockPath}`);
        this.name = "SessionWriteLockTimeoutError";
        this.timeoutMs = params.timeoutMs;
        this.owner = params.owner;
        this.lockPath = params.lockPath;
    }
}
export function isSessionWriteLockTimeoutError(err) {
    return (err instanceof SessionWriteLockTimeoutError ||
        Boolean(err &&
            typeof err === "object" &&
            err.code === SESSION_WRITE_LOCK_TIMEOUT_CODE));
}
