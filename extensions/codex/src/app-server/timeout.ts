import {
  racePromiseWithAbortSignal,
  raceWithTimeout,
  withTimeout as withSharedTimeout,
} from "openclaw/plugin-sdk/time-runtime";

function resolveAbortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("Codex app-server operation aborted", { cause: signal.reason });
}

export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  timeoutMessage: string,
  createError?: () => Error,
): Promise<T> {
  return await withSharedTimeout(promise, timeoutMs, {
    message: timeoutMessage,
    ...(createError ? { createError } : {}),
  });
}

/** Bounds an operation by both its owner lifecycle and one total wall-clock budget. */
export async function withAbortableTimeout<T>(params: {
  promise: Promise<T>;
  timeoutMs: number;
  signal?: AbortSignal;
  timeoutMessage: string;
  createTimeoutError?: () => Error;
}): Promise<T> {
  if (params.signal?.aborted) {
    throw resolveAbortError(params.signal);
  }
  if (!Number.isFinite(params.timeoutMs) || params.timeoutMs <= 0) {
    return await racePromiseWithAbortSignal(params.promise, params.signal, resolveAbortError);
  }
  return await raceWithTimeout(
    params.promise,
    params.timeoutMs,
    () => {
      throw params.createTimeoutError?.() ?? new Error(params.timeoutMessage);
    },
    {
      signal: params.signal,
      onAbort: (signal) => {
        throw resolveAbortError(signal);
      },
    },
  );
}

export async function waitForPromiseOrAbort(
  promise: Promise<unknown>,
  signal: AbortSignal,
): Promise<boolean> {
  if (signal.aborted) {
    return false;
  }
  const aborted = Symbol("codex-promise-aborted");
  return await racePromiseWithAbortSignal(
    promise.then(() => true),
    signal,
    () => aborted,
  ).catch((error: unknown) => {
    if (error !== aborted) {
      throw error;
    }
    return false;
  });
}

export function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error(String(signal.reason ?? "codex app-server thread route aborted"));
}
