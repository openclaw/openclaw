import { createDeferred } from "openclaw/plugin-sdk/concurrency-runtime";

export const DEFAULT_MEMORY_SEARCH_TIMEOUT_MS = 30_000;
export function resolveMemorySearchAbortError(signal: AbortSignal): Error {
  const { reason } = signal;
  if (reason instanceof Error) {
    return reason;
  }
  return new Error(typeof reason === "string" ? reason : "memory search aborted");
}

// The deadline owner is the only place that knows a failure is this tool's own
// timeout: a provider is free to emit the same text, and the catch path has
// flattened both to a string before recovery guidance is chosen. Membership is
// by object identity, never by a property, because the supervised task receives
// this error as `signal.reason` and could copy any marker on it onto a failure
// of its own.
const memorySearchDeadlineErrors = new WeakSet<object>();

export function createMemorySearchDeadlineError(message: string): Error {
  const error = new Error(message);
  memorySearchDeadlineErrors.add(error);
  return error;
}

export function isMemorySearchDeadlineError(error: unknown): boolean {
  return typeof error === "object" && error !== null && memorySearchDeadlineErrors.has(error);
}

export async function runMemorySearchWithDeadline<T>(params: {
  timeoutMs: number;
  parentSignal?: AbortSignal;
  run: (signal: AbortSignal) => Promise<T>;
}): Promise<T> {
  if (params.parentSignal?.aborted) {
    throw resolveMemorySearchAbortError(params.parentSignal);
  }

  const controller = new AbortController();
  const timeoutError = createMemorySearchDeadlineError(
    `memory_search timed out after ${Math.round(params.timeoutMs / 1000)}s`,
  );
  const cancellation = createDeferred<never>();
  const deadlineStartedAt = Date.now();
  const abort = (error: Error) => {
    // Reject before aborting so abort-aware tasks cannot replace the stable
    // deadline error with a provider-wrapped cancellation error.
    cancellation.reject(error);
    controller.abort(error);
  };
  const timer = setTimeout(() => abort(timeoutError), params.timeoutMs);
  timer.unref?.();
  const parentSignal = params.parentSignal;
  const onParentAbort = () => abort(resolveMemorySearchAbortError(parentSignal!));
  parentSignal?.addEventListener("abort", onParentAbort, { once: true });
  const task = Promise.resolve().then(() => params.run(controller.signal));

  try {
    const result = await Promise.race([task, cancellation.promise]);
    if (parentSignal?.aborted) {
      throw resolveMemorySearchAbortError(parentSignal);
    }
    if (Date.now() - deadlineStartedAt >= params.timeoutMs) {
      controller.abort(timeoutError);
      throw timeoutError;
    }
    return result;
  } finally {
    clearTimeout(timer);
    parentSignal?.removeEventListener("abort", onParentAbort);
  }
}
