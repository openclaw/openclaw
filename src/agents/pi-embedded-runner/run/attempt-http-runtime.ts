import {
  DEFAULT_UNDICI_STREAM_TIMEOUT_MS,
  ensureGlobalUndiciEnvProxyDispatcher,
  ensureGlobalUndiciStreamTimeouts,
} from "../../../infra/net/undici-global-dispatcher.js";

/**
 * Maximum HTTP body timeout for LLM requests (30 minutes).
 * Prevents a single stalled request from holding a lane indefinitely.
 */
const MAX_LLM_HTTP_TIMEOUT_MS = 30 * 60 * 1000;

export function configureEmbeddedAttemptHttpRuntime(params: { timeoutMs: number }): void {
  // Proxy bootstrap must happen before timeout tuning so the timeouts wrap the
  // active EnvHttpProxyAgent instead of being replaced by a bare proxy dispatcher.
  ensureGlobalUndiciEnvProxyDispatcher();
  // Cap the body timeout to prevent runaway LLM requests from occupying lanes
  // for hours. The application-level LLM idle timeout (typically 120s) provides
  // faster detection of stalled streams, but this cap protects at the HTTP layer
  // against slow-drip responses that reset the idle timer.
  const cappedTimeoutMs = Math.min(params.timeoutMs, MAX_LLM_HTTP_TIMEOUT_MS);
  ensureGlobalUndiciStreamTimeouts({ timeoutMs: cappedTimeoutMs });
}
