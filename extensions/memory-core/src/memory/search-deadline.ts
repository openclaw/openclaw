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
