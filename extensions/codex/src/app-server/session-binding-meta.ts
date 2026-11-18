/** Process-stable plugin-state metadata for Codex app-server bindings. */
export const CODEX_APP_SERVER_BINDING_NAMESPACE = "app-server-thread-bindings";
export const CODEX_APP_SERVER_BINDING_MAX_ENTRIES = 50_000;
export const CODEX_APP_SERVER_BINDING_GUARDED_REQUEST_TIMEOUT_MS = 60_000;
const staleMs = CODEX_APP_SERVER_BINDING_GUARDED_REQUEST_TIMEOUT_MS + 5_000;
export const CODEX_APP_SERVER_BINDING_LEASE = {
  staleMs,
  waitMs: staleMs + 5_000,
  retryIntervalMs: 1_000,
  renewIntervalMs: Math.floor(staleMs / 3),
};
// Physical keys cannot have a successor; retain their fence until stale lease work drains.
export const PHYSICAL_SESSION_RETIRE_TTL_MS = CODEX_APP_SERVER_BINDING_LEASE.waitMs;
