function getAbortReason(signal: AbortSignal): unknown {
  return "reason" in signal ? (signal as { reason?: unknown }).reason : undefined;
}

/**
 * Marker placed on every error produced by `makeAbortError()` (i.e., every
 * rejection emitted by `abortable()` when its signal fires). Used by the model
 * fallback layer to positively identify "this AbortError wraps a signal that
 * fired from within the OpenClaw embedded runner" — vs. a provider/SDK that
 * happens to throw an `AbortError(cause: TimeoutError)` for its own per-request
 * timeout (which must remain retryable through the configured fallback chain).
 * See `src/agents/model-fallback.ts` `isTerminalAbortFromError`.
 */
export const OPENCLAW_ABORTABLE_WRAPPER = Symbol.for("openclaw.abortable.wrapper");

export function isOpenClawAbortableWrapper(err: unknown): boolean {
  return err !== null && typeof err === "object" && OPENCLAW_ABORTABLE_WRAPPER in err;
}

function tagAsAbortableWrapper(err: Error): Error {
  (err as Error & { [OPENCLAW_ABORTABLE_WRAPPER]?: true })[OPENCLAW_ABORTABLE_WRAPPER] = true;
  return err;
}

function makeAbortError(signal: AbortSignal): Error {
  const reason = getAbortReason(signal);
  if (reason instanceof Error) {
    const err = new Error(reason.message, { cause: reason });
    err.name = "AbortError";
    return tagAsAbortableWrapper(err);
  }
  const err = reason ? new Error("aborted", { cause: reason }) : new Error("aborted");
  err.name = "AbortError";
  return tagAsAbortableWrapper(err);
}

export function abortable<T>(signal: AbortSignal, promise: Promise<T>): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(makeAbortError(signal));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(makeAbortError(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(toLintErrorObject(err, "Non-Error rejection"));
      },
    );
  });
}

function toLintErrorObject(value: unknown, fallbackMessage: string): Error {
  if (value instanceof Error) {
    return value;
  }
  if (typeof value === "string") {
    return new Error(value);
  }
  const error = new Error(fallbackMessage, { cause: value });
  if ((typeof value === "object" && value !== null) || typeof value === "function") {
    Object.assign(error, value);
  }
  return error;
}
