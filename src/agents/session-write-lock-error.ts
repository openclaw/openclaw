const SESSION_WRITE_LOCK_TIMEOUT_CODE = "OPENCLAW_SESSION_WRITE_LOCK_TIMEOUT";
const SESSION_WRITE_LOCK_STALE_OWNER_CODE = "OPENCLAW_SESSION_WRITE_LOCK_STALE_OWNER";

export class SessionWriteLockTimeoutError extends Error {
  readonly code = SESSION_WRITE_LOCK_TIMEOUT_CODE;
  readonly timeoutMs: number;
  readonly owner: string;
  readonly lockPath: string;

  constructor(params: { timeoutMs: number; owner: string; lockPath: string }) {
    super(
      `session file locked (timeout ${params.timeoutMs}ms): ${params.owner} ${params.lockPath}`,
    );
    this.name = "SessionWriteLockTimeoutError";
    this.timeoutMs = params.timeoutMs;
    this.owner = params.owner;
    this.lockPath = params.lockPath;
  }
}

export class SessionWriteLockStaleOwnerError extends Error {
  readonly code = SESSION_WRITE_LOCK_STALE_OWNER_CODE;
  readonly lockPath: string;

  constructor(params: { lockPath: string }) {
    super(`stale session write lock owner: ${params.lockPath}`);
    this.name = "SessionWriteLockStaleOwnerError";
    this.lockPath = params.lockPath;
  }
}

export function isSessionWriteLockTimeoutError(err: unknown): boolean {
  return (
    err instanceof SessionWriteLockTimeoutError ||
    Boolean(
      err &&
      typeof err === "object" &&
      (err as { code?: unknown }).code === SESSION_WRITE_LOCK_TIMEOUT_CODE,
    )
  );
}

export function isSessionWriteLockStaleOwnerError(err: unknown): boolean {
  return (
    err instanceof SessionWriteLockStaleOwnerError ||
    Boolean(
      err &&
      typeof err === "object" &&
      (err as { code?: unknown }).code === SESSION_WRITE_LOCK_STALE_OWNER_CODE,
    )
  );
}
