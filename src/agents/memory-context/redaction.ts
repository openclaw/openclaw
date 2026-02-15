/**
 * Redaction — mask common secret patterns before persisting to disk.
 *
 * Default patterns: Authorization headers, Bearer tokens, API keys,
 * long random hex/base64 strings that look like secrets.
 *
 * Configurable: can be disabled entirely via `redaction: false`.
 */

const REDACTION_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  // Authorization: Bearer <token>
  {
    pattern: /\b(Authorization\s*[:=]\s*)(Bearer\s+)\S{20,}/gi,
    replacement: "$1$2[REDACTED]",
  },
  // Bearer <token> standalone
  {
    pattern: /\bBearer\s+[A-Za-z0-9_\-.]{20,}/g,
    replacement: "Bearer [REDACTED]",
  },
  // apiKey / api_key / API_KEY = <value>
  {
    pattern: /\b(api[_-]?key\s*[:=]\s*["']?)[A-Za-z0-9_\-./+]{16,}["']?/gi,
    replacement: "$1[REDACTED]",
  },
  // token = <value> (generic)
  {
    pattern: /\b(token\s*[:=]\s*["']?)[A-Za-z0-9_\-./+]{20,}["']?/gi,
    replacement: "$1[REDACTED]",
  },
  // Hex strings that look like secrets (32+ hex chars)
  {
    pattern: /\b[0-9a-f]{32,}\b/gi,
    replacement: "[REDACTED_HEX]",
  },
  // Long base64-like strings (64+ chars, must contain + or / to reduce false positives on long identifiers)
  {
    pattern: /\b[A-Za-z0-9+/]{64,}={0,2}\b/g,
    replacement: "[REDACTED_B64]",
  },
];

/**
 * Apply redaction to text content.
 * Returns the redacted text (original is not modified).
 */
export function redact(text: string): string {
  let result = text;
  for (const { pattern, replacement } of REDACTION_PATTERNS) {
    // Reset lastIndex for global regex
    pattern.lastIndex = 0;
    result = result.replace(pattern, replacement);
  }
  return result;
}

/**
 * Conditionally apply redaction based on config flag.
 */
export function maybeRedact(text: string, enabled: boolean): string {
  if (!enabled) {
    return text;
  }
  return redact(text);
}
