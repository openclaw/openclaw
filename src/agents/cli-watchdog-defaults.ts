export const CLI_WATCHDOG_MIN_TIMEOUT_MS = 1_000;

// `maxMs` caps the "no output" watchdog ceiling. Originally 600_000 (10m) for fresh
// runs and 180_000 (3m) for resume. Raised to 60m: long-form reasoning, tool calls
// that legitimately take 5–10m, and SSE keepalive gaps were tripping false aborts.
// Per-CLI-backend overrides at `cli.watchdog.fresh.maxMs` / `.resume.maxMs` still apply.
export const CLI_FRESH_WATCHDOG_DEFAULTS = {
  noOutputTimeoutRatio: 0.8,
  minMs: 180_000,
  maxMs: 3_600_000,
} as const;

export const CLI_RESUME_WATCHDOG_DEFAULTS = {
  noOutputTimeoutRatio: 0.3,
  minMs: 60_000,
  maxMs: 3_600_000,
} as const;
