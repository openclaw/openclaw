// Dependency-free so repository checks can read the cap without loading the
// agent runtime; bootstrap.ts owns how the cap is resolved and applied.
export const DEFAULT_BOOTSTRAP_MAX_CHARS = 20_000;
