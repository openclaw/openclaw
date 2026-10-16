import type {
  CodexRequestWaiterFinished,
  CodexRequestWaiterOutcome,
  CodexRequestWaiterSummary,
  CodexRequestWireOutcome,
} from "./request-observation.js";
import {
  CodexAppServerLocalRequestCancellationError,
  CodexAppServerRpcError,
} from "./rpc-error.js";

type CodexRequestWaitOptions = {
  timeoutMs?: number;
  signal?: AbortSignal;
  attemptWaiterFinished?: CodexRequestWaiterFinished;
  overloadAttemptOrdinal: number;
};

type RequestWaiter = {
  resolve: (value: unknown) => void;
  reject: (error: Error, outcome: CodexRequestWaiterOutcome) => void;
};

type AttemptDiagnostics = Pick<
  CodexRequestWaiterSummary,
  | "clientInstanceId"
  | "rpcId"
  | "attemptCreatedAtMs"
  | "firstPossibleWriteAtMs"
  | "wireOutcomeAtWaiterSettlement"
  | "wireObservedAtMs"
>;

export type CodexRequestAttemptObservation =
  | { kind: "possible-write" }
  | { kind: "wire"; outcome: CodexRequestWireOutcome }
  | { kind: "waiter"; outcome: CodexRequestWaiterOutcome };

export type CodexRequestAttempt = {
  readonly method: string;
  readonly pending: boolean;
  wait: <T>(options: CodexRequestWaitOptions) => Promise<T>;
  resolve: (value: unknown) => void;
  reject: (error: Error, definitelyNotEnqueued?: boolean) => void;
  close: (error: Error) => void;
  failLocal: (error: Error) => void;
  markWritten: () => void;
};

export function remainingCodexRequestTime(
  method: string,
  signal: AbortSignal | undefined,
  deadline?: number,
): number | undefined {
  if (signal?.aborted) {
    throw new CodexAppServerLocalRequestCancellationError(method, "aborted", false, signal.reason);
  }
  const remainingMs = deadline === undefined ? undefined : deadline - performance.now();
  if (remainingMs !== undefined && remainingMs <= 0) {
    throw new CodexAppServerLocalRequestCancellationError(method, "timed out", false);
  }
  return remainingMs;
}

/** One caller per wire attempt; local waiter expiry need not imply a native response. */
export function createCodexRequestAttempt(params: {
  method: string;
  /** Only catalog requests retain these scalar facts across unobserved waiters. */
  diagnosticIdentity?: Pick<CodexRequestWaiterSummary, "clientInstanceId" | "rpcId">;
  observe?: (event: CodexRequestAttemptObservation) => void;
  onSettled: () => void;
  onIngressRejected?: () => void;
  cancellationError: (
    reason: "aborted" | "timed out",
    mayHaveWritten: boolean,
    cause?: unknown,
  ) => Error;
  localError: (error: Error, mayHaveWritten: boolean) => Error;
}): CodexRequestAttempt {
  let pending = true;
  let mayHaveWritten = false;
  let waiter: RequestWaiter | undefined;
  const observeAttempt = (event: CodexRequestAttemptObservation) => {
    try {
      params.observe?.(event);
    } catch {
      // Observation cannot change request settlement or transport ownership.
    }
  };
  const diagnostics: AttemptDiagnostics | undefined = params.diagnosticIdentity
    ? {
        ...params.diagnosticIdentity,
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
    observeAttempt({ kind: "wire", outcome });
    if (diagnostics) {
      diagnostics.wireOutcomeAtWaiterSettlement = outcome;
      diagnostics.wireObservedAtMs = performance.now();
    }
    params.onSettled();
    return true;
  };
  return {
    method: params.method,
    get pending() {
      return pending;
    },
    wait<T>(options: CodexRequestWaitOptions) {
      const { timeoutMs, signal, overloadAttemptOrdinal } = options;
      let observe = options.attemptWaiterFinished;
      return new Promise<T>((resolve, reject) => {
        if (!pending) {
          reject(new Error("Codex request attempt is already settled"));
          return;
        }
        let timer: ReturnType<typeof setTimeout> | undefined;
        let removeAbort: (() => void) | undefined;
        const waiterAttachedAtMs = diagnostics && observe ? performance.now() : 0;
        const detach = (waiterOutcome: CodexRequestWaiterOutcome) => {
          if (!waiter) {
            return false;
          }
          waiter = undefined;
          clearTimeout(timer);
          timer = undefined;
          removeAbort?.();
          removeAbort = undefined;
          finish(mayHaveWritten ? "correlation-closed" : "not-written");
          observeAttempt({ kind: "waiter", outcome: waiterOutcome });
          const callback = observe;
          observe = undefined;
          if (diagnostics && callback) {
            try {
              callback({
                ...diagnostics,
                waiterOrdinal: 1,
                disposition: "new",
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
        const localWaiter: RequestWaiter = {
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
        };
        waiter = localWaiter;
        if (timeoutMs && Number.isFinite(timeoutMs) && timeoutMs > 0) {
          timer = setTimeout(
            () =>
              localWaiter.reject(
                params.cancellationError("timed out", mayHaveWritten),
                "timed-out",
              ),
            Math.max(100, timeoutMs),
          );
          timer.unref?.();
        }
        if (signal) {
          const abort = () =>
            localWaiter.reject(
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
      waiter?.resolve(value);
    },
    reject(error, definitelyNotEnqueued = false) {
      if (finish(definitelyNotEnqueued ? "ingress-rejected" : "native-error")) {
        // Ingress rejection remains definite even if a caller's deadline has
        // elapsed before its timer runs. Preserve that fact before projection.
        if (definitelyNotEnqueued) {
          mayHaveWritten = false;
          params.onIngressRejected?.();
        }
        waiter?.reject(
          error instanceof CodexAppServerRpcError
            ? error
            : params.localError(error, mayHaveWritten),
          "native-error",
        );
      }
    },
    close(error) {
      if (finish("correlation-closed")) {
        // Connection closure ends correlation, not the possibly written native operation.
        waiter?.reject(params.localError(error, mayHaveWritten), "client-closed");
      }
    },
    failLocal(error) {
      if (!pending) {
        return;
      }
      finish(mayHaveWritten ? "correlation-closed" : "not-written");
      waiter?.reject(params.localError(error, mayHaveWritten), "local-failed");
    },
    markWritten() {
      mayHaveWritten = true;
      observeAttempt({ kind: "possible-write" });
      if (diagnostics && diagnostics.firstPossibleWriteAtMs === null) {
        diagnostics.firstPossibleWriteAtMs = performance.now();
      }
    },
  };
}
