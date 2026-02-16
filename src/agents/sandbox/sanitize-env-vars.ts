/**
 * Environment variable sanitization for Docker sandbox containers.
 * Prevents credential leakage via environment variable injection.
 *
 * Security Principles:
 * 1. Blocklist sensitive credential patterns
 * 2. Allowlist safe variables (optional)
 * 3. Audit log all sanitization decisions
 * 4. Fail-secure: block by default if uncertain
 *
 * Threat model: Prevent sensitive credentials from being exposed in sandbox
 * containers where they could be exfiltrated by malicious code or exploits.
 */

// Sensitive environment variable patterns (blocklist)
const BLOCKED_ENV_VAR_PATTERNS = [
  // API Keys
  /^ANTHROPIC_API_KEY$/i,
  /^ANTHROPIC_OAUTH_TOKEN$/i,
  /^OPENAI_API_KEY$/i,
  /^GEMINI_API_KEY$/i,
  /^ZAI_API_KEY$/i,
  /^OPENROUTER_API_KEY$/i,
  /^AI_GATEWAY_API_KEY$/i,
  /^MINIMAX_API_KEY$/i,
  /^SYNTHETIC_API_KEY$/i,
  /^ELEVENLABS_API_KEY$/i,

  // Bot Tokens
  /^TELEGRAM_BOT_TOKEN$/i,
  /^DISCORD_BOT_TOKEN$/i,
  /^SLACK_BOT_TOKEN$/i,
  /^SLACK_APP_TOKEN$/i,
  /^LINE_CHANNEL_SECRET$/i,
  /^LINE_CHANNEL_ACCESS_TOKEN$/i,

  // Gateway Credentials
  /^OPENCLAW_GATEWAY_TOKEN$/i,
  /^OPENCLAW_GATEWAY_PASSWORD$/i,

  // Generic patterns (catch common credential naming)
  /.*_API_KEY$/i,
  /.*_SECRET$/i,
  /.*_TOKEN$/i,
  /.*_PASSWORD$/i,
  /.*_PRIVATE_KEY$/i,
  /^AWS_.*$/i,
  /^AZURE_.*$/i,
  /^GCP_.*$/i,
  /^GOOGLE_.*_KEY$/i,

  // SSH and GPG
  /^SSH_.*$/i,
  /^GPG_.*$/i,

  // Database credentials
  /^DB_PASSWORD$/i,
  /^DATABASE_URL$/i,
  /^MYSQL_PASSWORD$/i,
  /^POSTGRES_PASSWORD$/i,
];

// Safe environment variables (allowlist - optional, defaults to allow all non-blocked)
const ALLOWED_ENV_VAR_PATTERNS = [
  /^LANG$/,
  /^LC_.*$/,
  /^TZ$/,
  /^PATH$/,
  /^HOME$/,
  /^USER$/,
  /^SHELL$/,
  /^TERM$/,
  /^DEBUG$/i,
  /^NODE_ENV$/,
  /^LOG_LEVEL$/i,
  /^WORKSPACE$/,
];

export type EnvVarSanitizationResult = {
  allowed: Record<string, string>;
  blocked: Array<{ key: string; reason: string }>;
  warnings: string[];
};

/**
 * Validate environment variable value format
 */
function validateEnvVarValue(value: string): { valid: boolean; reason?: string } {
  // Check for suspicious patterns in value
  if (value.includes("\0")) {
    return { valid: false, reason: "Contains null bytes" };
  }

  if (value.length > 32768) {
    return { valid: false, reason: "Value exceeds maximum length (32KB)" };
  }

  // Check for base64-encoded credentials (common pattern)
  // If value looks like base64 and is suspiciously long, flag it
  const base64Pattern = /^[A-Za-z0-9+/=]{100,}$/;
  if (base64Pattern.test(value)) {
    return { valid: true, reason: "Warning: Value looks like base64-encoded data" };
  }

  return { valid: true };
}

/**
 * Sanitize environment variables before passing to Docker container
 */
export function sanitizeEnvVars(
  envVars: Record<string, string>,
  options: {
    strictMode?: boolean; // If true, only allow explicitly whitelisted vars
    customBlockedPatterns?: RegExp[];
    customAllowedPatterns?: RegExp[];
  } = {},
): EnvVarSanitizationResult {
  const result: EnvVarSanitizationResult = {
    allowed: {},
    blocked: [],
    warnings: [],
  };

  const blockedPatterns = [...BLOCKED_ENV_VAR_PATTERNS, ...(options.customBlockedPatterns || [])];

  const allowedPatterns = [...ALLOWED_ENV_VAR_PATTERNS, ...(options.customAllowedPatterns || [])];

  for (const [key, value] of Object.entries(envVars)) {
    // Skip empty keys
    if (!key || !key.trim()) {
      result.warnings.push(`Skipped empty environment variable key`);
      continue;
    }

    // Check blocklist first (highest priority)
    let isBlocked = false;
    for (const pattern of blockedPatterns) {
      if (pattern.test(key)) {
        isBlocked = true;
        break;
      }
    }

    if (isBlocked) {
      result.blocked.push({
        key,
        reason: "Matches blocked credential pattern",
      });
      console.warn(`[Security] Blocked sensitive environment variable: ${key}`);
      continue;
    }

    // In strict mode, check allowlist
    if (options.strictMode) {
      let isAllowed = false;
      for (const pattern of allowedPatterns) {
        if (pattern.test(key)) {
          isAllowed = true;
          break;
        }
      }

      if (!isAllowed) {
        result.blocked.push({
          key,
          reason: "Not in allowlist (strict mode)",
        });
        console.warn(`[Security] Blocked non-whitelisted variable: ${key}`);
        continue;
      }
    }

    // Validate value format
    const valueValidation = validateEnvVarValue(value);
    if (!valueValidation.valid) {
      result.blocked.push({
        key,
        reason: valueValidation.reason || "Invalid value format",
      });
      console.warn(`[Security] Blocked invalid env var value: ${key} - ${valueValidation.reason}`);
      continue;
    }

    if (valueValidation.reason) {
      result.warnings.push(`${key}: ${valueValidation.reason}`);
    }

    // Passed all checks - allow
    result.allowed[key] = value;
  }

  // Audit log
  console.log("[Security] Environment variable sanitization:", {
    total: Object.keys(envVars).length,
    allowed: Object.keys(result.allowed).length,
    blocked: result.blocked.length,
    warnings: result.warnings.length,
  });

  return result;
}

/**
 * Get list of blocked environment variable patterns (for documentation/debugging)
 */
export function getBlockedPatterns(): string[] {
  return BLOCKED_ENV_VAR_PATTERNS.map((p) => p.source);
}

/**
 * Get list of allowed environment variable patterns (for documentation/debugging)
 */
export function getAllowedPatterns(): string[] {
  return ALLOWED_ENV_VAR_PATTERNS.map((p) => p.source);
}
