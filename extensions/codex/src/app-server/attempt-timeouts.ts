import { resolveTimerTimeoutMs } from "openclaw/plugin-sdk/number-runtime";
import { raceWithTimeout } from "openclaw/plugin-sdk/time-runtime";
import type { CodexAppServerClient } from "./client.js";
import { codexPrewriteRejectionCause } from "./rpc-error.js";

const CODEX_APP_SERVER_STARTUP_TIMEOUT_FLOOR_MS = 100;
// Startup issues several sequential app-server requests across up to three
// attempts and may wait for a retired owner's exit. Observed startups take
// seconds to a few minutes; ten request timeouts stays generous on slow hosts.
const CODEX_APP_SERVER_STARTUP_REQUEST_TIMEOUT_MULTIPLE = 10;
// Native terminal receipt must still reach local settlement; a blocked
// projection must not retain the session lane indefinitely.
export const TURN_TERMINAL_SETTLEMENT_TIMEOUT_MS = 2 * 60_000;
// Aborted/timed-out completions still join queued projection work; this grace
// bounds a blocked handler tail so finalization cannot hang forever.
export const TURN_FINALIZE_DRAIN_ABORT_GRACE_MS = 5_000;

export const CODEX_APP_SERVER_INITIALIZE_TIMEOUT_MESSAGE = "codex app-server initialize timed out";

type CodexAppServerStartupErrorReason = "aborted" | "timed_out";

export class CodexAppServerStartupError extends Error {
  readonly code = "CODEX_APP_SERVER_STARTUP_CANCELLED";

  constructor(
    readonly reason: CodexAppServerStartupErrorReason,
    message = reason === "timed_out"
      ? "codex app-server startup timed out"
      : "codex app-server startup aborted",
  ) {
    super(message);
    this.name = "CodexAppServerStartupError";
  }
}

export function buildCodexAppServerInitializeTimeoutError(
  client: CodexAppServerClient | undefined,
): CodexAppServerStartupError {
  const stderr = client?.getStderrDiagnostic();
  return new CodexAppServerStartupError(
    "timed_out",
    stderr
      ? `${CODEX_APP_SERVER_INITIALIZE_TIMEOUT_MESSAGE}; stderr=${JSON.stringify(stderr)}`
      : CODEX_APP_SERVER_INITIALIZE_TIMEOUT_MESSAGE,
  );
}

export function isCodexAppServerStartupError(
  error: unknown,
  reason?: CodexAppServerStartupErrorReason,
): boolean {
  const cause = codexPrewriteRejectionCause(error);
  return (
    cause instanceof Error &&
    "code" in cause &&
    cause.code === "CODEX_APP_SERVER_STARTUP_CANCELLED" &&
    "reason" in cause &&
    (cause.reason === "aborted" || cause.reason === "timed_out") &&
    (reason === undefined || cause.reason === reason)
  );
}

export async function withCodexStartupTimeout<T>(params: {
  timeoutMs: number;
  signal: AbortSignal;
  onTimeout?: () => void | Promise<void>;
  operation: () => Promise<T>;
}): Promise<T> {
  if (params.signal.aborted) {
    throw new CodexAppServerStartupError("aborted");
  }
  let timeoutError: Error | undefined;
  let timeoutCleanup: Promise<void> | undefined;
  try {
    return await raceWithTimeout(
      params.operation,
      params.timeoutMs,
      () => {
        timeoutError = new CodexAppServerStartupError("timed_out");
        timeoutCleanup = Promise.resolve(params.onTimeout?.()).then(
          () => undefined,
          () => undefined,
        );
        throw timeoutError;
      },
      {
        signal: params.signal,
        onAbort: () => {
          throw new CodexAppServerStartupError("aborted");
        },
      },
    );
  } catch (error) {
    if (timeoutError) {
      await timeoutCleanup;
      throw timeoutError;
    }
    throw error;
  }
}

/**
 * Bounds physical startup by a multiple of the configured request timeout.
 * Turn startup additionally respects its own remaining budget.
 */
export function resolveCodexStartupTimeoutMs(params: {
  timeoutMs?: number;
  requestTimeoutMs?: number;
  timeoutFloorMs?: number;
}): number {
  const timeoutFloorMs = resolveTimerTimeoutMs(
    params.timeoutFloorMs,
    CODEX_APP_SERVER_STARTUP_TIMEOUT_FLOOR_MS,
  );
  const turnTimeoutMs = resolveTimerTimeoutMs(params.timeoutMs, timeoutFloorMs);
  const requestBudgetMs =
    params.requestTimeoutMs === undefined
      ? turnTimeoutMs
      : resolveTimerTimeoutMs(
          params.requestTimeoutMs * CODEX_APP_SERVER_STARTUP_REQUEST_TIMEOUT_MULTIPLE,
          turnTimeoutMs,
        );
  return Math.max(
    timeoutFloorMs,
    params.timeoutMs === undefined ? requestBudgetMs : Math.min(turnTimeoutMs, requestBudgetMs),
  );
}
