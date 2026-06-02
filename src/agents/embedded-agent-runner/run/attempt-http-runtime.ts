import {
  DEFAULT_UNDICI_STREAM_TIMEOUT_MS,
  ensureGlobalUndiciDispatcherStreamTimeouts,
  ensureGlobalUndiciEnvProxyDispatcher,
} from "../../../infra/net/undici-global-dispatcher.js";

/**
 * Configures the process-wide HTTP runtime used by embedded attempts. Proxy
 * setup runs first so timeout tuning wraps the active dispatcher.
 */
export function configureEmbeddedAttemptHttpRuntime(params: { timeoutMs: number }): void {
  // Proxy bootstrap must happen before timeout tuning so the timeouts wrap the
  // active EnvHttpProxyAgent instead of being replaced by a bare proxy dispatcher.
  ensureGlobalUndiciEnvProxyDispatcher();
  ensureGlobalUndiciDispatcherStreamTimeouts({
    timeoutMs: Math.max(params.timeoutMs, DEFAULT_UNDICI_STREAM_TIMEOUT_MS),
  });
}
