import { racePromiseWithAbortSignal } from "../infra/abort-signal.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { redactMcpDiagnosticError } from "./mcp-error.js";

type StartupState = {
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
  constructor(
    state: StartupState,
    readonly reportFailure: boolean,
  ) {
    super(
      `${state.message}; server unavailable; retry after ${new Date(state.retryAfterMs).toISOString()}. Check server reachability or reload MCP after fixing it.`,
    );
    this.retryAfterMs = state.retryAfterMs;
  }
  readonly retryAfterMs: number;
}

export function resetMcpStartupBackoff(key?: string): void {
  if (key === undefined) {
    startups.clear();
  } else {
    startups.delete(key);
  }
}

export async function connectWithMcpStartupBackoff(
  key: string,
  signal: AbortSignal,
  connect: () => Promise<void>,
): Promise<void> {
  // Serialize startup, not transport ownership: healthy sessions still connect independently.
  while (startups.get(key)?.pending) {
    await racePromiseWithAbortSignal(
      startups.get(key)!.pending!.catch(() => undefined),
      signal,
    );
  }
  signal.throwIfAborted();
  const state = startups.get(key) ?? { delayMs: 15_000, retryAfterMs: 0, message: "" };
  if (Date.now() < state.retryAfterMs) {
    throw new McpStartupBackoffError(state, false);
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
      if (startups.get(key) === state) {
        startups.delete(key);
      }
      throw error;
    }
    state.delayMs = Math.min(state.delayMs * 2, 600_000);
    state.retryAfterMs = Date.now() + state.delayMs;
    state.message = redactMcpDiagnosticError(error);
    throw new McpStartupBackoffError(state, true);
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
