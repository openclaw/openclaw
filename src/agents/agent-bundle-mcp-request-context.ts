import { AsyncLocalStorage } from "node:async_hooks";
import { withGuardedFetchRequestAuthority } from "../infra/net/fetch-request-authority.js";
import { getAsyncWorkSignal } from "../shared/async-work-scope.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";

const REQUEST_SIGNAL_KEY = Symbol.for("openclaw.sessionMcpRequestSignal");
const requestSignals = resolveGlobalSingleton<AsyncLocalStorage<AbortSignal>>(
  REQUEST_SIGNAL_KEY,
  () => new AsyncLocalStorage(),
);

export function getSessionMcpRequestSignal(): AbortSignal | undefined {
  const caller = requestSignals.getStore();
  const owner = getAsyncWorkSignal();
  // Retiring a work owner must cancel MCP requests before joining their handlers;
  // transport disposal happens later, after the handlers release their leases.
  return caller && owner ? AbortSignal.any([caller, owner]) : (caller ?? owner);
}

export function runWithSessionMcpRequestSignal<T>(
  signal: AbortSignal | undefined,
  run: () => T,
): T {
  return signal ? requestSignals.run(signal, run) : run();
}

const CALL_AUTHORITY_KEY = Symbol.for("openclaw.sessionMcpToolCallAuthority");
const callAuthorities = resolveGlobalSingleton<AsyncLocalStorage<() => void>>(
  CALL_AUTHORITY_KEY,
  () => new AsyncLocalStorage(),
);

/** Caller-owned liveness check that MCP tools/call re-runs immediately before server I/O. */
export function getSessionMcpToolCallAuthority(): (() => void) | undefined {
  return callAuthorities.getStore();
}

export function runWithSessionMcpToolCallAuthority<T>(
  assertCurrent: (() => void) | undefined,
  run: () => T,
): T {
  return assertCurrent ? callAuthorities.run(assertCurrent, run) : run();
}

/**
 * Binds a configured-server request to the loopback caller's grant: it is
 * rechecked at the request boundary, including after reconnection or catalog
 * refresh waits, and carried into guarded fetches.
 */
export function withSessionMcpCallerAuthority<A extends unknown[], T>(
  request: (...args: A) => Promise<T>,
): (...args: A) => Promise<T> {
  const callerAuthority = getSessionMcpToolCallAuthority();
  return callerAuthority
    ? (...args) => {
        callerAuthority();
        return withGuardedFetchRequestAuthority(callerAuthority, () => request(...args));
      }
    : request;
}
