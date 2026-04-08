export function createMatrixStartupAbortError(): Error {
  const error = new Error("Matrix startup aborted");
  error.name = "AbortError";
  return error;
}

export function throwIfMatrixStartupAborted(abortSignal?: AbortSignal): void {
  if (abortSignal?.aborted === true) {
    throw createMatrixStartupAbortError();
  }
}

export function isMatrixStartupAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
