export type PromptErrorWithCode = Error & { code?: string; cause?: unknown };

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
