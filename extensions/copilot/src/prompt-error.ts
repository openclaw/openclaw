export type PromptErrorWithCode = Error & { code?: string; cause?: unknown };

export function createCopilotAbortError(reason: unknown): Error {
  if (reason instanceof Error) {
    return reason;
  }
  const error = new Error("aborted", reason ? { cause: reason } : undefined);
  error.name = "AbortError";
  return error;
}

export function createPromptError(
  code: string,
  message: string,
  cause?: unknown,
): PromptErrorWithCode {
  const error: PromptErrorWithCode = new Error(message);
  error.code = code;
  if (cause !== undefined) {
    error.cause = cause;
  }
  return error;
}
