import { sleepWithAbort } from "openclaw/plugin-sdk/runtime-env";
import { CodexAppServerStartupError } from "./attempt-timeouts.js";
import { withTimeout } from "./timeout.js";
import { isCodexWebSocketOpenFailure } from "./transport-websocket.js";

const INITIALIZE_INTERRUPTED = "CODEX_APP_SERVER_WEBSOCKET_INITIALIZE_INTERRUPTED";

/** Only call at the WebSocket initialize boundary, before auth or thread requests. */
export function markRetryableCodexInitializeTransportError(error: unknown): unknown {
  if (!(error instanceof Error)) {
    return error;
  }
  const seen = new Set<Error>();
  let cause: unknown = error;
  while (cause instanceof Error && !seen.has(cause)) {
    seen.add(cause);
    if (
      ("exitCode" in cause && cause.exitCode === 1006) ||
      ("code" in cause && cause.code === "ECONNRESET")
    ) {
      return Object.assign(new Error(error.message, { cause: error }), {
        code: INITIALIZE_INTERRUPTED,
      });
    }
    cause = cause.cause;
  }
  return error;
}

/** Recovers physical startup, including acquisitions before thread preparation. */
export async function withCodexWebSocketStartupRetry<T>(params: {
  timeoutMs: number;
  signal: AbortSignal;
  start: (remainingTimeoutMs: number) => Promise<T>;
}): Promise<T> {
  const startedAt = performance.now();
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await params.start(resolveRemainingAcquireTimeout(params.timeoutMs, startedAt));
    } catch (error) {
      // A new connection may repeat initialize. Auth, thread and tool requests
      // are outside that boundary and are never replayed by this recovery.
      const initializeInterrupted =
        error instanceof Error && "code" in error && error.code === INITIALIZE_INTERRUPTED;
      if (
        params.signal.aborted ||
        attempt >= 3 ||
        (!isCodexWebSocketOpenFailure(error) && !initializeInterrupted)
      ) {
        throw initializeInterrupted && error instanceof Error && error.cause instanceof Error
          ? error.cause
          : error;
      }
      const remaining = resolveRemainingAcquireTimeout(params.timeoutMs, startedAt);
      const delay = 1_000 * 2 ** (attempt - 1);
      await sleepWithAbort(remaining > 0 ? Math.min(delay, remaining) : delay, params.signal);
    }
  }
}

export function resolveRemainingAcquireTimeout(timeoutMs: number, startedAt: number): number {
  if (!(timeoutMs > 0)) {
    return timeoutMs;
  }
  const remaining = timeoutMs - (performance.now() - startedAt);
  if (remaining <= 0) {
    throw new CodexAppServerStartupError("timed_out", "codex app-server initialize timed out");
  }
  return remaining;
}

export async function withCodexAppServerAcquireDeadline<T>(
  timeoutMs: number, // First: fail before the caller starts its promise argument.
  promise: Promise<T>,
  signal?: AbortSignal,
  timeoutMessage = "codex app-server initialize timed out",
  timeoutErrorFactory?: () => CodexAppServerStartupError,
): Promise<T> {
  if (signal?.aborted) {
    throw new CodexAppServerStartupError("aborted", "codex app-server initialize aborted");
  }
  const timed = withTimeout(
    promise,
    timeoutMs,
    timeoutMessage,
    () => timeoutErrorFactory?.() ?? new CodexAppServerStartupError("timed_out", timeoutMessage),
  );
  if (!signal) {
    return await timed;
  }
  return await new Promise<T>((resolve, reject) => {
    const onAbort = () =>
      reject(new CodexAppServerStartupError("aborted", "codex app-server initialize aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    timed.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}
