import { withTimeout as withSharedTimeout } from "openclaw/plugin-sdk/time-runtime";

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
  const signal = params.signal;
  if (signal?.aborted) {
    throw resolveAbortError(signal);
  }
  let removeAbortListener: (() => void) | undefined;
  const operation = signal
    ? Promise.race([
        params.promise,
        new Promise<never>((_, reject) => {
          const onAbort = () => reject(resolveAbortError(signal));
          signal.addEventListener("abort", onAbort, { once: true });
          removeAbortListener = () => signal.removeEventListener("abort", onAbort);
        }),
      ])
    : params.promise;
  try {
    return await withTimeout(
      operation,
      params.timeoutMs,
      params.timeoutMessage,
      params.createTimeoutError,
    );
  } finally {
    removeAbortListener?.();
  }
}

export async function waitForPromiseOrAbort(
  promise: Promise<unknown>,
  signal: AbortSignal,
): Promise<boolean> {
  if (signal.aborted) {
    return false;
  }
  let removeAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise<boolean>((resolve) => {
        const onAbort = () => resolve(false);
        signal.addEventListener("abort", onAbort, { once: true });
        removeAbort = () => signal.removeEventListener("abort", onAbort);
        if (signal.aborted) {
          onAbort();
        }
      }),
    ]);
  } finally {
    removeAbort?.();
  }
}

export function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error(String(signal.reason ?? "codex app-server thread route aborted"));
}
