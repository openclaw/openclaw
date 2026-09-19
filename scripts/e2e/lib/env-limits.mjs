// Environment limit helpers for E2E subprocess scenarios.
//
// Callers whose value reaches setTimeout pass a ceiling, because Node collapses a
// timer delay above it to 1 ms; byte, count, and other non-timer limits pass none
// and stay unbounded. These helpers run under plain `node`, which does not resolve
// the workspace tsconfig alias for @openclaw/normalization-core, so the ceiling
// mirrors that owner's exported constant and the e2e helper test pins the two
// together.
export const MAX_TIMER_TIMEOUT_MS = 2_147_000_000;

export function readPositiveIntEnv(
  name,
  fallback,
  env = process.env,
  max = Number.POSITIVE_INFINITY,
) {
  const raw = env[name] ?? fallback;
  const text = raw == null ? "unset" : String(raw).trim();
  if (!/^\d+$/u.test(text)) {
    throw new Error(`invalid ${name}: ${text}`);
  }
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value <= 0 || value > max) {
    throw new Error(`invalid ${name}: ${text}`);
  }
  return value;
}

/** Reads a positive integer that must also be a valid TCP port. */
export function readTcpPortEnv(name, fallback, env = process.env) {
  return readPositiveIntEnv(name, fallback, env, 65_535);
}

export function readPositiveIntEnvWithEmptyFallback(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") {
    return fallback;
  }
  const text = raw.trim();
  if (!/^\d+$/u.test(text)) {
    throw new Error(`${name} must be a positive integer; got: ${raw}`);
  }
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer; got: ${raw}`);
  }
  return parsed;
}
