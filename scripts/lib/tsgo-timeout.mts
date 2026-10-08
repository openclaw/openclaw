import { readPositiveEnvInt } from "./numeric-options.mjs";

// Sparse preflight cannot load workspace packages. Keep the script parser here;
// core consumers of local-check-runtime do not compile JavaScript.
// Mirrors normalization-core's MAX_TIMER_TIMEOUT_MS.
const MAX_TIMER_TIMEOUT_MS = 2_147_000_000;

export function resolveTsgoTimeoutMs(env: NodeJS.ProcessEnv): number | undefined {
  if (!env.OPENCLAW_TSGO_TIMEOUT_MS?.trim()) {
    return undefined;
  }
  return Math.min(
    readPositiveEnvInt("OPENCLAW_TSGO_TIMEOUT_MS", env, MAX_TIMER_TIMEOUT_MS),
    MAX_TIMER_TIMEOUT_MS,
  );
}
