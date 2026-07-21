export const CLI_WATCHDOG_MIN_TIMEOUT_MS = 1_000;

// minMs is the floor for assistant-token silence on a fresh turn. Now that the
// no-output watchdog re-arms only on real assistant-token progress (not on
// every byte), 180s was needlessly slack: a genuine slow first token after a
// large-prompt compaction lands in single-digit seconds, so a 90s floor still
// never trips a live turn yet catches a hung turn an order of magnitude sooner.
export const CLI_FRESH_WATCHDOG_DEFAULTS = {
  noOutputTimeoutRatio: 0.8,
  minMs: 90_000,
  maxMs: 600_000,
} as const;

export const CLI_RESUME_WATCHDOG_DEFAULTS = {
  noOutputTimeoutRatio: 0.3,
  minMs: 60_000,
  maxMs: 180_000,
} as const;
