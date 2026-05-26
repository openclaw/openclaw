//#region src/agents/session-write-lock-error.ts
const SESSION_WRITE_LOCK_TIMEOUT_CODE = "OPENCLAW_SESSION_WRITE_LOCK_TIMEOUT";
var SessionWriteLockTimeoutError = class extends Error {
	constructor(params) {
		super(`session file locked (timeout ${params.timeoutMs}ms): ${params.owner} ${params.lockPath}`);
		this.code = SESSION_WRITE_LOCK_TIMEOUT_CODE;
		this.name = "SessionWriteLockTimeoutError";
		this.timeoutMs = params.timeoutMs;
		this.owner = params.owner;
		this.lockPath = params.lockPath;
	}
};
function isSessionWriteLockTimeoutError(err) {
	return err instanceof SessionWriteLockTimeoutError || Boolean(err && typeof err === "object" && err.code === SESSION_WRITE_LOCK_TIMEOUT_CODE);
}
//#endregion
export { isSessionWriteLockTimeoutError as n, SessionWriteLockTimeoutError as t };
