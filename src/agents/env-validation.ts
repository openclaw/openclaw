/**
 * Allowlist-based environment variable validation (CWE-20 mitigation).
 * Only explicitly approved variables with validated values pass through.
 */

type Validator = (value: string) => boolean;

const MAX_VALUE_LENGTH = 8192;

// Shell injection patterns blocked in all values
const DANGEROUS_VALUE_RE = /\$\(|`|\$\{|;\s*\w|\|\s*\w|&&\s*\w|\|\|\s*\w|>\s*\/|<\s*\//;

// Allowlist: variable name -> value validator
const ALLOWED_ENV_VARS = new Map<string, Validator>([
  // Identity
  ["USER", validateIdentifier],
  ["LOGNAME", validateIdentifier],
  ["USERNAME", validateIdentifier],

  // Terminal
  ["TERM", validateTerminal],
  ["COLORTERM", validateTerminal],
  ["TERM_PROGRAM", validateTerminal],
  ["TERM_PROGRAM_VERSION", validateVersion],
  ["COLUMNS", validateNumeric],
  ["LINES", validateNumeric],

  // Color flags
  ["FORCE_COLOR", validateBooleanish],
  ["NO_COLOR", validateBooleanish],
  ["CLICOLOR", validateBooleanish],
  ["CLICOLOR_FORCE", validateBooleanish],

  // Shell identification
  ["SHELL", validateShellPath],

  // SSH context
  ["SSH_TTY", validateDevicePath],
  ["SSH_CONNECTION", validateSshConnection],

  // Operational
  ["SHLVL", validateNumeric],
  ["PWD", validateAbsolutePath],
  ["OLDPWD", validateAbsolutePath],
  ["DISPLAY", validateDisplay],

  // Paths (restricted)
  ["HOME", validateHomePath],

  // Locale (restricted)
  ["LANG", validateLocale],
  ["LC_ALL", validateLocale],
  ["LC_CTYPE", validateLocale],

  // Timezone
  ["TZ", validateTimezone],
]);

// ---------------------------------------------------------------------------
// Base validation applied to all values
// ---------------------------------------------------------------------------

function hasUnsafeContent(value: string): boolean {
  if (value.length > MAX_VALUE_LENGTH) {
    return true;
  }
  if (value.includes("\0")) {
    return true;
  }
  if (value.includes("\n") || value.includes("\r")) {
    return true;
  }
  return DANGEROUS_VALUE_RE.test(value);
}

/**
 * Classify why a value was rejected (for test assertions).
 */
function rejectReason(
  value: string,
): "NULL_BYTES" | "INVALID_CHARACTERS" | "VALUE_TOO_LONG" | "SHELL_METACHARACTERS" {
  if (value.includes("\0")) {
    return "NULL_BYTES";
  }
  if (value.includes("\n") || value.includes("\r")) {
    return "INVALID_CHARACTERS";
  }
  if (value.length > MAX_VALUE_LENGTH) {
    return "VALUE_TOO_LONG";
  }
  return "SHELL_METACHARACTERS";
}

// ---------------------------------------------------------------------------
// Per-variable validators
// ---------------------------------------------------------------------------

function validateIdentifier(value: string): boolean {
  return /^[a-zA-Z_][a-zA-Z0-9_-]{0,63}$/.test(value);
}

function validateTerminal(value: string): boolean {
  return /^[a-zA-Z0-9_-]{1,64}$/.test(value);
}

function validateVersion(value: string): boolean {
  return /^[a-zA-Z0-9._-]{1,32}$/.test(value);
}

function validateNumeric(value: string): boolean {
  if (!/^-?\d{1,10}$/.test(value)) {
    return false;
  }
  const n = parseInt(value, 10);
  return !isNaN(n) && n >= -2147483648 && n <= 2147483647;
}

function validateBooleanish(value: string): boolean {
  return ["0", "1", "true", "false", "yes", "no", ""].includes(value.toLowerCase());
}

const ALLOWED_SHELLS = new Set([
  "/bin/sh",
  "/bin/bash",
  "/bin/zsh",
  "/bin/fish",
  "/bin/dash",
  "/usr/bin/sh",
  "/usr/bin/bash",
  "/usr/bin/zsh",
  "/usr/bin/fish",
  "/usr/local/bin/bash",
  "/usr/local/bin/zsh",
  "/usr/local/bin/fish",
  "/opt/homebrew/bin/bash",
  "/opt/homebrew/bin/zsh",
  "/opt/homebrew/bin/fish",
]);

function validateShellPath(value: string): boolean {
  return ALLOWED_SHELLS.has(value);
}

function validateDevicePath(value: string): boolean {
  return /^\/dev\/[a-zA-Z0-9/]{1,32}$/.test(value);
}

function validateSshConnection(value: string): boolean {
  return /^[\d.:a-fA-F]+ \d+ [\d.:a-fA-F]+ \d+$/.test(value);
}

function validateAbsolutePath(value: string): boolean {
  if (!value.startsWith("/")) {
    return false;
  }
  if (value.includes("..") || value.includes("./")) {
    return false;
  }
  return /^[a-zA-Z0-9/_.-]{1,4096}$/.test(value);
}

function validateHomePath(value: string): boolean {
  if (!validateAbsolutePath(value)) {
    return false;
  }
  const validPrefixes = ["/home/", "/Users/", "/root"];
  return validPrefixes.some(
    (prefix) => value === prefix.replace(/\/$/, "") || value.startsWith(prefix),
  );
}

function validateDisplay(value: string): boolean {
  return /^([a-zA-Z0-9._-]+)?:\d{1,3}(\.\d{1,3})?$/.test(value);
}

function validateLocale(value: string): boolean {
  if (["C", "POSIX", "C.UTF-8"].includes(value)) {
    return true;
  }
  return /^[a-z]{2}_[A-Z]{2}(\.UTF-8)?$/.test(value);
}

function validateTimezone(value: string): boolean {
  if (/^[+-]\d{4}$/.test(value)) {
    return true;
  }
  if (/^[A-Z][a-zA-Z_]+(\/[A-Za-z_]+){1,2}$/.test(value)) {
    return true;
  }
  const abbreviations = new Set([
    "UTC",
    "GMT",
    "EST",
    "PST",
    "CST",
    "MST",
    "EDT",
    "PDT",
    "CDT",
    "MDT",
  ]);
  return abbreviations.has(value);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type EnvRejectionReason =
  | "NOT_IN_WHITELIST"
  | "VALUE_TOO_LONG"
  | "INVALID_CHARACTERS"
  | "NULL_BYTES"
  | "SHELL_METACHARACTERS"
  | "VALUE_VALIDATION_FAILED";

export interface EnvValidationResult {
  allowed: boolean;
  value?: string;
  reason?: EnvRejectionReason;
}

/**
 * Validate a single environment variable against the allowlist.
 */
export function validateEnvVar(name: string, value: string): EnvValidationResult {
  const validator = ALLOWED_ENV_VARS.get(name);
  if (!validator) {
    return { allowed: false, reason: "NOT_IN_WHITELIST" };
  }

  if (hasUnsafeContent(value)) {
    return { allowed: false, reason: rejectReason(value) };
  }

  if (!validator(value)) {
    return { allowed: false, reason: "VALUE_VALIDATION_FAILED" };
  }

  return { allowed: true, value };
}

/**
 * Filter an environment object, keeping only allowlisted variables with valid values.
 */
export function validateHostEnv(env: Record<string, string | undefined>): Record<string, string> {
  const result: Record<string, string> = {};

  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) {
      continue;
    }

    const v = validateEnvVar(name, value);
    if (v.allowed && v.value !== undefined) {
      result[name] = v.value;
    }
  }

  return result;
}
