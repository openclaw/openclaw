/**
 * Environment variable secret filtering for sandbox containers.
 *
 * Uses an allowlist + pattern approach:
 * - Allowlisted vars are always passed through (PATH, HOME, etc.)
 * - Vars matching secret patterns are always stripped
 * - Everything else passes through
 */

/** Patterns that match secret-like environment variable names. Case-insensitive. */
export const SECRET_PATTERNS: RegExp[] = [
  /api[_-]?key/i,
  /secret/i,
  /token/i,
  /password/i,
  /credential/i,
  /private[_-]?key/i,
  /^openai/i,
  /^anthropic/i,
  /^aws_/i,
  /^azure_/i,
  /^gcp_/i,
  /^google_/i,
];

/** Environment variables that are always safe to pass through. */
export const SANDBOX_ENV_ALLOWLIST: ReadonlySet<string> = new Set([
  "PATH",
  "HOME",
  "USER",
  "SHELL",
  "TERM",
  "LANG",
  "LC_ALL",
  "NODE_ENV",
  "TZ",
]);

/**
 * Returns true if the given key matches any secret pattern.
 */
export function isSecretKey(key: string): boolean {
  return SECRET_PATTERNS.some((pattern) => pattern.test(key));
}

/**
 * Filters an environment variable record, removing secrets.
 *
 * - Allowlisted vars are always kept (even if they match a secret pattern).
 * - Vars matching secret patterns are dropped.
 * - All other vars are kept.
 */
export function filterSecretsFromEnv(env: Record<string, string>): Record<string, string> {
  const filtered: Record<string, string> = {};

  for (const [key, value] of Object.entries(env)) {
    if (SANDBOX_ENV_ALLOWLIST.has(key)) {
      filtered[key] = value;
    } else if (!isSecretKey(key)) {
      filtered[key] = value;
    }
    // Otherwise: matches a secret pattern and is not allowlisted => drop
  }

  return filtered;
}
