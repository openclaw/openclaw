import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import {
  collectErrorGraphCandidates,
  readErrorCauses,
} from "@openclaw/normalization-core/error-coercion";
import { racePromiseWithAbortSignal } from "../infra/abort-signal.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type { SessionMcpRequesterScope } from "./agent-bundle-mcp-types.js";

type StartupState = {
  owner: AbortSignal;
  delayMs: number;
  retryAfterMs: number;
  message: string;
  pending?: Promise<void>;
  authorization?: AuthorizationObservation & { error: Error };
};

type AuthorizationObservation = { isCurrent: () => boolean; dispose: () => void };
const authorizationCapture = resolveGlobalSingleton(
  Symbol.for("openclaw.mcpStartupAuthorizationCapture"),
  () => new AsyncLocalStorage<(error: Error, observe: () => AuthorizationObservation) => void>(),
);

/** Capture denial at its credential owner, before asynchronous cleanup can yield. */
export function recordMcpStartupAuthorizationRequired(
  error: Error,
  observe: () => AuthorizationObservation,
): void {
  authorizationCapture.getStore()?.(error, observe);
}

// Survives session retirement; config publication and explicit MCP reload reset it.
const startups = resolveGlobalSingleton(
  Symbol.for("openclaw.mcpStartupBackoff"),
  () => new Map<string, StartupState>(),
);

let errorModule: Promise<typeof import("./mcp-error.js")> | undefined;

export class McpStartupBackoffError extends Error {
  readonly retryAfterMs: number;
  readonly authorizationRequired: boolean;

  constructor(
    state: StartupState,
    readonly reportFailure: boolean,
    signal: AbortSignal,
    recoveryRetryMs: number,
  ) {
    // Only the first failing runtime gets one early retry on its catalog schedule.
    const retryAfterMs = state.authorization
      ? Infinity
      : state.owner === signal && state.delayMs === 30_000
        ? state.retryAfterMs - state.delayMs + recoveryRetryMs
        : state.retryAfterMs;
    super(
      state.authorization
        ? state.message
        : `${state.message}; server unavailable; retry after ${new Date(retryAfterMs).toISOString()}. Check server reachability or reload MCP after fixing it.`,
    );
    this.retryAfterMs = retryAfterMs;
    this.authorizationRequired = state.authorization !== undefined;
  }
}

export function resetMcpStartupBackoff(key?: string): void {
  if (key === undefined) {
    for (const state of startups.values()) {
      state.authorization?.dispose();
    }
    startups.clear();
  } else {
    startups.get(key)?.authorization?.dispose();
    startups.delete(key);
  }
}

function getMcpStartupBackoff(
  key: string,
  signal: AbortSignal,
  recoveryRetryMs: number,
  authorizationKey = key,
): McpStartupBackoffError | undefined {
  const stateKey = startups.has(authorizationKey) ? authorizationKey : key;
  const state = startups.get(stateKey);
  if (state?.authorization && !state.authorization.isCurrent()) {
    resetMcpStartupBackoff(stateKey);
    return undefined;
  }
  if (!state?.message) {
    return undefined;
  }
  return new McpStartupBackoffError(state, false, signal, recoveryRetryMs);
}

async function connectWithMcpStartupBackoff(
  key: string,
  signal: AbortSignal,
  connect: () => Promise<void>,
  recoveryRetryMs: number,
  authorizationKey = key,
): Promise<void> {
  const { redactMcpDiagnosticError } = await (errorModule ??= import("./mcp-error.js"));
  // Serialize startup, not transport ownership: healthy sessions still connect independently.
  while (startups.get(key)?.pending) {
    await racePromiseWithAbortSignal(
      startups.get(key)!.pending!.catch(() => undefined),
      signal,
    );
  }
  signal.throwIfAborted();
  const backoff = getMcpStartupBackoff(key, signal, recoveryRetryMs, authorizationKey);
  if (backoff && Date.now() < backoff.retryAfterMs) {
    throw backoff;
  }
  const state: StartupState = startups.get(key) ?? {
    owner: signal,
    delayMs: 15_000,
    retryAfterMs: 0,
    message: "",
  };
  startups.set(key, state);
  let stateKey = key;
  let capturing = true;
  try {
    state.pending = authorizationCapture.run((error, observe) => {
      if (capturing && startups.get(key) === state) {
        state.authorization?.dispose();
        state.authorization = { error, ...observe() };
      }
    }, connect);
    await state.pending;
    if (startups.get(key) === state) {
      resetMcpStartupBackoff(key);
    }
  } catch (error) {
    if (
      signal.aborted ||
      (state.authorization &&
        !collectErrorGraphCandidates(error, readErrorCauses).includes(state.authorization.error))
    ) {
      state.authorization?.dispose();
      state.authorization = undefined;
    }
    if (signal.aborted) {
      if (!state.message && startups.get(key) === state) {
        startups.delete(key);
      }
      throw error;
    }
    state.delayMs = Math.min(state.delayMs * 2, 600_000);
    state.retryAfterMs = Date.now() + state.delayMs;
    state.message = redactMcpDiagnosticError(error);
    const reportFailure =
      !state.authorization ||
      !startups.has(authorizationKey) ||
      startups.get(authorizationKey) === state;
    if (state.authorization && startups.get(key) === state && authorizationKey !== key) {
      resetMcpStartupBackoff(authorizationKey);
      startups.delete(key);
      stateKey = authorizationKey;
      startups.set(stateKey, state);
    }
    throw new McpStartupBackoffError(state, reportFailure, signal, recoveryRetryMs);
  } finally {
    capturing = false;
    state.pending = undefined;
    if (startups.get(stateKey) !== state) {
      state.authorization?.dispose();
    }
    // Bound retired configurations without evicting an active startup admission.
    for (const [oldKey, oldState] of startups) {
      if (startups.size <= 1_024) {
        break;
      }
      if (!oldState.pending) {
        resetMcpStartupBackoff(oldKey);
      }
    }
  }
}

/** A runtime owns transient failures; credential denials outlive native capability contexts. */
export function createMcpStartupBackoff(params: {
  identity: readonly [
    workspaceDir: string,
    agentDir: string | undefined,
    requester: SessionMcpRequesterScope | undefined,
    serverName: string,
    configFingerprint: string,
  ];
  signal: AbortSignal;
  recoveryRetryMs: number;
  runScoped: boolean;
}) {
  const key = JSON.stringify([...params.identity, ...(params.runScoped ? [randomUUID()] : [])]);
  // Native OAuth credentials belong to the server/principal, not an agent workspace.
  const authorizationKey = JSON.stringify([...params.identity.slice(2), "oauth-authorization"]);
  return {
    get: () => getMcpStartupBackoff(key, params.signal, params.recoveryRetryMs, authorizationKey),
    connect: (connect: () => Promise<void>) =>
      connectWithMcpStartupBackoff(
        key,
        params.signal,
        connect,
        params.recoveryRetryMs,
        authorizationKey,
      ),
    reset() {
      resetMcpStartupBackoff(key);
      resetMcpStartupBackoff(authorizationKey);
    },
    dispose() {
      if (params.runScoped) {
        resetMcpStartupBackoff(key);
      }
    },
  };
}
