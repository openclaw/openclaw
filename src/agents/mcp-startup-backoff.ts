import { racePromiseWithAbortSignal } from "../infra/abort-signal.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";

type StartupState = {
  owner: AbortSignal;
  delayMs: number;
  retryAfterMs: number;
  message: string;
  pending?: Promise<void>;
};

// Survives session retirement; config publication and explicit MCP reload reset it.
const startups = resolveGlobalSingleton(
  Symbol.for("openclaw.mcpStartupBackoff"),
  () => new Map<string, StartupState>(),
);

export class McpStartupBackoffError extends Error {
  readonly retryAfterMs: number;

  constructor(
    state: StartupState,
    readonly reportFailure: boolean,
    signal: AbortSignal,
    recoveryRetryMs: number,
  ) {
    // Only the first failing runtime gets one early retry on its catalog schedule.
    const retryAfterMs =
      state.owner === signal && state.delayMs === 30_000
        ? state.retryAfterMs - state.delayMs + recoveryRetryMs
        : state.retryAfterMs;
    super(
      `${state.message}; server unavailable; retry after ${new Date(retryAfterMs).toISOString()}. Check server reachability or reload MCP after fixing it.`,
    );
    this.retryAfterMs = retryAfterMs;
  }
}

export function resetMcpStartupBackoff(key?: string): void {
  if (key === undefined) {
    startups.clear();
  } else {
    startups.delete(key);
  }
}

export function getMcpStartupBackoff(
  key: string,
  signal: AbortSignal,
  recoveryRetryMs: number,
): McpStartupBackoffError | undefined {
  const state = startups.get(key);
  if (!state?.message) {
    return undefined;
  }
  return new McpStartupBackoffError(state, false, signal, recoveryRetryMs);
}

export async function connectWithMcpStartupBackoff(
  key: string,
  signal: AbortSignal,
  connect: () => Promise<void>,
  recoveryRetryMs: number,
): Promise<void> {
  const { redactMcpDiagnosticError } = await import("./mcp-error.js");
  // Serialize startup, not transport ownership: healthy sessions still connect independently.
  while (startups.get(key)?.pending) {
    await racePromiseWithAbortSignal(
      startups.get(key)!.pending!.catch(() => undefined),
      signal,
    );
  }
  signal.throwIfAborted();
  const state = startups.get(key) ?? {
    owner: signal,
    delayMs: 15_000,
    retryAfterMs: 0,
    message: "",
  };
  const backoff = getMcpStartupBackoff(key, signal, recoveryRetryMs);
  if (backoff && Date.now() < backoff.retryAfterMs) {
    throw backoff;
  }
  startups.set(key, state);
  try {
    state.pending = connect();
    await state.pending;
    if (startups.get(key) === state) {
      startups.delete(key);
    }
  } catch (error) {
    if (signal.aborted) {
      if (!state.message && startups.get(key) === state) {
        startups.delete(key);
      }
      throw error;
    }
    state.delayMs = Math.min(state.delayMs * 2, 600_000);
    state.retryAfterMs = Date.now() + state.delayMs;
    state.message = redactMcpDiagnosticError(error);
    throw new McpStartupBackoffError(state, true, signal, recoveryRetryMs);
  } finally {
    state.pending = undefined;
    // Bound retired configurations without evicting an active startup admission.
    for (const [oldKey, oldState] of startups) {
      if (startups.size <= 1_024) {
        break;
      }
      if (!oldState.pending) {
        startups.delete(oldKey);
      }
    }
  }
}
