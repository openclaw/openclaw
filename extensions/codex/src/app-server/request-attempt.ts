import { toStringifiedError } from "openclaw/plugin-sdk/error-runtime";

type CodexRequestWaitOptions = {
  timeoutMs?: number;
  signal?: AbortSignal;
  assertCurrent?: () => void;
};

type RequestWaiter = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  cleanup: () => void;
  signal?: AbortSignal;
  deadline?: number;
  assertCurrent?: () => void;
};

export type CodexRequestAttempt = {
  readonly method: string;
  readonly pending: boolean;
  wait: <T>(options: CodexRequestWaitOptions, deadline?: number) => Promise<T>;
  resolve: (value: unknown) => void;
  reject: (error: Error, definitelyNotEnqueued?: boolean) => void;
  close: (error: Error) => void;
  failLocal: (error: Error) => void;
  markWritten: () => void;
  cleanup: () => void;
};

/** One wire attempt; local waiter expiry need not imply a native response. */
export function createCodexRequestAttempt(params: {
  method: string;
  retainWritten: boolean;
  onSettled: () => void;
  /** A correlated native response, never local cancellation or transport closure. */
  onResponse?: (mayHaveWritten: boolean) => void;
  cancellationError: (
    reason: "aborted" | "timed out",
    mayHaveWritten: boolean,
    cause?: unknown,
  ) => Error;
  localError: (error: Error, mayHaveWritten: boolean) => Error;
}): CodexRequestAttempt {
  let pending = true;
  let mayHaveWritten = false;
  const waiters = new Set<RequestWaiter>();
  const finish = () => {
    if (!pending) {
      return false;
    }
    pending = false;
    params.onSettled();
    return true;
  };
  const rejectWaiters = (error: Error) => {
    for (const waiter of waiters) {
      waiter.reject(error);
    }
  };
  const currentWaiterError = (waiter: RequestWaiter): Error | undefined => {
    if (!params.retainWritten) {
      return undefined;
    }
    if (waiter.signal?.aborted) {
      return params.cancellationError("aborted", mayHaveWritten, waiter.signal.reason);
    }
    if (waiter.deadline !== undefined && Date.now() >= waiter.deadline) {
      return params.cancellationError("timed out", mayHaveWritten);
    }
    try {
      waiter.assertCurrent?.();
    } catch (error) {
      return toStringifiedError(error);
    }
    if (waiter.signal?.aborted) {
      return params.cancellationError("aborted", mayHaveWritten, waiter.signal.reason);
    }
    if (waiter.deadline !== undefined && Date.now() >= waiter.deadline) {
      return params.cancellationError("timed out", mayHaveWritten);
    }
    return undefined;
  };
  return {
    method: params.method,
    get pending() {
      return pending;
    },
    wait<T>({ timeoutMs, signal, assertCurrent }: CodexRequestWaitOptions, deadline?: number) {
      return new Promise<T>((resolve, reject) => {
        if (!pending) {
          reject(new Error("Codex request attempt is already settled"));
          return;
        }
        let timer: ReturnType<typeof setTimeout> | undefined;
        let removeAbort: (() => void) | undefined;
        const cleanup = () => {
          clearTimeout(timer);
          timer = undefined;
          removeAbort?.();
          removeAbort = undefined;
        };
        const detach = () => {
          waiters.delete(waiter);
          cleanup();
          if (waiters.size === 0 && (!params.retainWritten || !mayHaveWritten)) {
            finish();
          }
        };
        const waiter: RequestWaiter = {
          resolve: (value) => {
            detach();
            // SAFETY: The method-typed client caller owns T at this JSON-RPC response boundary.
            resolve(value as T);
          },
          reject: (error) => {
            detach();
            reject(error);
          },
          cleanup,
          signal,
          ...(params.retainWritten ? { deadline, assertCurrent } : {}),
        };
        waiters.add(waiter);
        if (params.retainWritten && deadline !== undefined && Date.now() >= deadline) {
          waiter.reject(params.cancellationError("timed out", mayHaveWritten));
          return;
        }
        if (timeoutMs && Number.isFinite(timeoutMs) && timeoutMs > 0) {
          const remaining =
            params.retainWritten && deadline !== undefined ? deadline - Date.now() : timeoutMs;
          timer = setTimeout(
            () => waiter.reject(params.cancellationError("timed out", mayHaveWritten)),
            Math.max(params.retainWritten ? 1 : 100, remaining),
          );
          timer.unref?.();
        }
        if (signal) {
          const abort = () =>
            waiter.reject(params.cancellationError("aborted", mayHaveWritten, signal.reason));
          signal.addEventListener("abort", abort, { once: true });
          removeAbort = () => signal.removeEventListener("abort", abort);
          if (signal.aborted) {
            abort();
          }
        }
      });
    },
    resolve(value) {
      if (!finish()) {
        return;
      }
      params.onResponse?.(mayHaveWritten);
      for (const waiter of waiters) {
        const error = currentWaiterError(waiter);
        if (error) {
          waiter.reject(error);
        } else {
          waiter.resolve(value);
        }
      }
    },
    reject(error, definitelyNotEnqueued = false) {
      if (finish()) {
        // Ingress rejection remains definite even if a caller's deadline has
        // elapsed before its timer runs. Preserve that fact before projection.
        if (definitelyNotEnqueued) {
          mayHaveWritten = false;
        }
        params.onResponse?.(mayHaveWritten);
        for (const waiter of waiters) {
          waiter.reject(currentWaiterError(waiter) ?? params.localError(error, mayHaveWritten));
        }
      }
    },
    close(error) {
      if (finish()) {
        // Connection closure ends correlation, not the possibly written native operation.
        rejectWaiters(params.localError(error, mayHaveWritten));
      }
    },
    failLocal(error) {
      if (!pending) {
        return;
      }
      if (!params.retainWritten || !mayHaveWritten) {
        finish();
      }
      rejectWaiters(params.localError(error, mayHaveWritten));
    },
    markWritten() {
      mayHaveWritten = true;
    },
    cleanup() {
      for (const waiter of waiters) {
        waiter.cleanup();
      }
    },
  };
}
