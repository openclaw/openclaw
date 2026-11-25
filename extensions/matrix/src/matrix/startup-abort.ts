import { toErrorObject } from "openclaw/plugin-sdk/error-runtime";
import { racePromiseWithAbortSignal } from "openclaw/plugin-sdk/time-runtime";

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

export async function awaitMatrixStartupWithAbort<T>(
  promise: Promise<T>,
  abortSignal?: AbortSignal,
): Promise<T> {
  if (!abortSignal) {
    return await promise;
  }
  try {
    return await racePromiseWithAbortSignal(promise, abortSignal, createMatrixStartupAbortError);
  } catch (error) {
    throw toErrorObject(error, "Non-Error rejection");
  }
}
