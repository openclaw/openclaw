export const CLI_WATCHDOG_MIN_TIMEOUT_MS = 1_000;

export const CLI_FRESH_WATCHDOG_DEFAULTS = {
  noOutputTimeoutRatio: 0.8,
  minMs: 180_000,
  maxMs: 1_800_000, // Raised from 600_000 (10min) to 1_800_000 (30min)
} as const;

export const CLI_RESUME_WATCHDOG_DEFAULTS = {
  noOutputTimeoutRatio: 0.3,
  minMs: 60_000,
  maxMs: 600_000, // Raised from 180_000 (3min) to 600_000 (10min)
} as const;

// Backwards-compatible: users who need longer watchdog timeouts can override via
// backend.reliability.watchdog.fresh.maxMs / resume.maxMs in openclaw.json.
// See CliBackendWatchdogModeSchema in zod-schema.core.ts.

