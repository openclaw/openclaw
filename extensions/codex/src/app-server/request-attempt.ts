import { toStringifiedError } from "openclaw/plugin-sdk/error-runtime";
import type {
  CodexRequestWaiterFinished,
  CodexRequestWaiterOutcome,
  CodexRequestWaiterSummary,
  CodexRequestWireOutcome,
} from "./request-observation.js";

type CodexRequestWaitOptions = {
  timeoutMs?: number;
  signal?: AbortSignal;
  assertCurrent?: () => void;
  attemptWaiterFinished?: CodexRequestWaiterFinished;
  disposition: "new" | "joined";
  overloadAttemptOrdinal: number;
};

type RequestWaiter = {
  resolve: (value: unknown) => void;
  reject: (error: Error, outcome: CodexRequestWaiterOutcome) => void;
  cleanup: () => void;
  signal?: AbortSignal;
  deadline?: number;
  assertCurrent?: () => void;
};

type WaiterFailure = { error: Error; outcome: CodexRequestWaiterOutcome };
type AttemptDiagnostics = Pick<
  CodexRequestWaiterSummary,
  | "clientInstanceId"
  | "rpcId"
  | "waiterOrdinal"
  | "attemptCreatedAtMs"
  | "firstPossibleWriteAtMs"
  | "wireOutcomeAtWaiterSettlement"
  | "wireObservedAtMs"
>;

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
  /** Only catalog requests retain these scalar facts across unobserved waiters. */
  diagnosticIdentity?: Pick<CodexRequestWaiterSummary, "clientInstanceId" | "rpcId">;
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
  const diagnostics: AttemptDiagnostics | undefined = params.diagnosticIdentity
    ? {
        ...params.diagnosticIdentity,
        waiterOrdinal: 0,
        attemptCreatedAtMs: performance.now(),
        firstPossibleWriteAtMs: null,
        wireOutcomeAtWaiterSettlement: "retained-pending",
        wireObservedAtMs: null,
      }
    : undefined;
  const finish = (outcome: CodexRequestWireOutcome) => {
    if (!pending) {
      return false;
    }
    pending = false;
    if (diagnostics) {
      diagnostics.wireOutcomeAtWaiterSettlement = outcome;
      diagnostics.wireObservedAtMs = performance.now();
    }
    params.onSettled();
    return true;
  };
  const rejectWaiters = (error: Error, outcome: CodexRequestWaiterOutcome) => {
    for (const waiter of waiters) {
      waiter.reject(error, outcome);
    }
  };
  const currentWaiterError = (waiter: RequestWaiter): WaiterFailure | undefined => {
    if (!params.retainWritten) {
      return undefined;
    }
    if (waiter.signal?.aborted) {
      return {
        error: params.cancellationError("aborted", mayHaveWritten, waiter.signal.reason),
        outcome: "aborted",
      };
    }
    if (waiter.deadline !== undefined && performance.now() >= waiter.deadline) {
      return { error: params.cancellationError("timed out", mayHaveWritten), outcome: "timed-out" };
    }
    try {
      waiter.assertCurrent?.();
    } catch (error) {
      return { error: toStringifiedError(error), outcome: "authority-rejected" };
    }
    if (waiter.signal?.aborted) {
      return {
        error: params.cancellationError("aborted", mayHaveWritten, waiter.signal.reason),
        outcome: "aborted",
      };
    }
    if (waiter.deadline !== undefined && performance.now() >= waiter.deadline) {
      return { error: params.cancellationError("timed out", mayHaveWritten), outcome: "timed-out" };
    }
    return undefined;
  };
  return {
    method: params.method,
    get pending() {
      return pending;
    },
    wait<T>(options: CodexRequestWaitOptions, deadline?: number) {
      const { timeoutMs, signal, assertCurrent, disposition, overloadAttemptOrdinal } = options;
      let observe = options.attemptWaiterFinished;
      return new Promise<T>((resolve, reject) => {
        if (!pending) {
          reject(new Error("Codex request attempt is already settled"));
          return;
        }
        let timer: ReturnType<typeof setTimeout> | undefined;
        let removeAbort: (() => void) | undefined;
        const waiterOrdinal = diagnostics ? ++diagnostics.waiterOrdinal : 0;
        const waiterAttachedAtMs = diagnostics && observe ? performance.now() : 0;
        const cleanup = () => {
          clearTimeout(timer);
          timer = undefined;
          removeAbort?.();
          removeAbort = undefined;
        };
        const detach = (waiterOutcome: CodexRequestWaiterOutcome) => {
          // A delivery guard can abort this waiter before returning its own error.
          if (!waiters.delete(waiter)) {
            return false;
          }
          cleanup();
          if (waiters.size === 0 && (!params.retainWritten || !mayHaveWritten)) {
            finish(mayHaveWritten ? "correlation-closed" : "not-written");
          }
          const callback = observe;
          observe = undefined;
          if (diagnostics && callback) {
            try {
              callback({
                ...diagnostics,
                waiterOrdinal,
                disposition,
                overloadAttemptOrdinal,
                waiterAttachedAtMs,
                waiterSettledAtMs: performance.now(),
                waiterOutcome,
              });
            } catch {
              // Diagnostics must not replace the request's result or error.
            }
          }
          return true;
        };
        const waiter: RequestWaiter = {
          resolve: (value) => {
            if (!detach("resolved")) {
              return;
            }
            // SAFETY: The method-typed client caller owns T at this JSON-RPC response boundary.
            resolve(value as T);
          },
          reject: (error, outcome) => {
            if (detach(outcome)) {
              reject(error);
            }
          },
          cleanup,
          signal,
          ...(params.retainWritten ? { deadline, assertCurrent } : {}),
        };
        waiters.add(waiter);
        if (params.retainWritten && deadline !== undefined && performance.now() >= deadline) {
          waiter.reject(params.cancellationError("timed out", mayHaveWritten), "timed-out");
          return;
        }
        if (timeoutMs && Number.isFinite(timeoutMs) && timeoutMs > 0) {
          const remaining =
            params.retainWritten && deadline !== undefined
              ? deadline - performance.now()
              : timeoutMs;
          timer = setTimeout(
            () => waiter.reject(params.cancellationError("timed out", mayHaveWritten), "timed-out"),
            Math.max(params.retainWritten ? 1 : 100, remaining),
          );
          timer.unref?.();
        }
        if (signal) {
          const abort = () =>
            waiter.reject(
              params.cancellationError("aborted", mayHaveWritten, signal.reason),
              "aborted",
            );
          signal.addEventListener("abort", abort, { once: true });
          removeAbort = () => signal.removeEventListener("abort", abort);
          if (signal.aborted) {
            abort();
          }
        }
      });
    },
    resolve(value) {
      if (!finish("native-ok")) {
        return;
      }
      params.onResponse?.(mayHaveWritten);
      for (const waiter of waiters) {
        const error = currentWaiterError(waiter);
        if (error) {
          waiter.reject(error.error, error.outcome);
        } else {
          waiter.resolve(value);
        }
      }
    },
    reject(error, definitelyNotEnqueued = false) {
      if (finish(definitelyNotEnqueued ? "ingress-rejected" : "native-error")) {
        // Ingress rejection remains definite even if a caller's deadline has
        // elapsed before its timer runs. Preserve that fact before projection.
        if (definitelyNotEnqueued) {
          mayHaveWritten = false;
        }
        params.onResponse?.(mayHaveWritten);
        for (const waiter of waiters) {
          const current = currentWaiterError(waiter);
          waiter.reject(
            current?.error ?? params.localError(error, mayHaveWritten),
            current?.outcome ?? "native-error",
          );
        }
      }
    },
    close(error) {
      if (finish("correlation-closed")) {
        // Connection closure ends correlation, not the possibly written native operation.
        rejectWaiters(params.localError(error, mayHaveWritten), "client-closed");
      }
    },
    failLocal(error) {
      if (!pending) {
        return;
      }
      if (!params.retainWritten || !mayHaveWritten) {
        finish(mayHaveWritten ? "correlation-closed" : "not-written");
      }
      rejectWaiters(params.localError(error, mayHaveWritten), "local-failed");
    },
    markWritten() {
      mayHaveWritten = true;
      if (diagnostics && diagnostics.firstPossibleWriteAtMs === null) {
        diagnostics.firstPossibleWriteAtMs = performance.now();
      }
    },
    cleanup() {
      for (const waiter of waiters) {
        waiter.cleanup();
      }
    },
  };
}
