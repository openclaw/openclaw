// Error code for session busy - returned when a session is already processing a turn
// This allows callers to distinguish "session busy, retry" from "real crash/timeout"
// Exit code 75 (EX_TEMPFAIL) indicates temporary failure - caller should retry

export const SESSION_BUSY_ERROR_CODE = "SESSION_BUSY" as const;
export const SESSION_BUSY_EXIT_CODE = 75; // EX_TEMPFAIL from sysexits.h

export class SessionBusyError extends Error {
  readonly code = SESSION_BUSY_ERROR_CODE;
  readonly exitCode = SESSION_BUSY_EXIT_CODE;

  constructor(sessionKey: string, message?: string) {
    super(
      message ??
        `Session ${sessionKey} is busy processing another turn. ` +
          `Use exit code ${SESSION_BUSY_EXIT_CODE} (EX_TEMPFAIL) to detect this condition.`,
    );
    this.name = "SessionBusyError";
  }

  toJSON(): object {
    return {
      error: this.code,
      message: this.message,
      exitCode: this.exitCode,
      retryable: true,
    };
  }
}
