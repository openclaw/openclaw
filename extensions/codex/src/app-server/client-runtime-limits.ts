/** Match Codex's native grace window without retaining inactive conversations indefinitely. */
export const LIVE_THREAD_IDLE_TIMEOUT_MS = 30 * 60_000;
/** Native-child parents are active ownership, so only otherwise-idle threads count against this cap. */
export const LIVE_THREAD_MAX_IDLE = 64;
/** Return a deterministic error before Codex cancels its ten-second external-auth request. */
export const EXTERNAL_AUTH_REFRESH_TIMEOUT_MS = 9_000;
