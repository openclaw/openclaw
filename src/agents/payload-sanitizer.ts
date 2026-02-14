/**
 * Sanitize API payloads before logging to prevent sensitive data exposure (CWE-532).
 * Detects and redacts API keys, tokens, PII, and sensitive field values.
 */

const SECRET_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  // Provider-specific API keys
  { name: "OPENAI_PROJECT_KEY", pattern: /sk-proj-[a-zA-Z0-9_-]{20,}/gi },
  { name: "OPENAI_API_KEY", pattern: /sk-[a-zA-Z0-9]{20,}/gi },
  { name: "ANTHROPIC_API_KEY", pattern: /sk-ant-[a-zA-Z0-9_-]{20,}/gi },
  { name: "AWS_ACCESS_KEY", pattern: /AKIA[0-9A-Z]{16}/gi },
  { name: "GITHUB_TOKEN", pattern: /gh[pousr]_[A-Za-z0-9_]{36,}/gi },
  { name: "GITHUB_FINE_GRAINED", pattern: /github_pat_[A-Za-z0-9_]{22,}/gi },
  { name: "GOOGLE_API_KEY", pattern: /AIza[0-9A-Za-z_-]{35}/gi },
  // Generic auth patterns
  { name: "BEARER_TOKEN", pattern: /Bearer\s+[a-zA-Z0-9_\-.~+/]+=*/gi },
  { name: "BASIC_AUTH", pattern: /Basic\s+[a-zA-Z0-9+/]+=*/gi },
  { name: "JWT_TOKEN", pattern: /eyJ[a-zA-Z0-9_-]*\.eyJ[a-zA-Z0-9_-]*\.[a-zA-Z0-9_-]*/gi },
  {
    name: "PRIVATE_KEY",
    pattern:
      /-----BEGIN\s+(?:RSA\s+)?PRIVATE\s+KEY-----[\s\S]*?-----END\s+(?:RSA\s+)?PRIVATE\s+KEY-----/gi,
  },
  // PII patterns
  { name: "SSN", pattern: /\b\d{3}-\d{2}-\d{4}\b/g },
  {
    name: "CREDIT_CARD",
    pattern:
      /\b(?:4[0-9]{12}(?:[0-9]{3})?|5[1-5][0-9]{14}|3[47][0-9]{13}|6(?:011|5[0-9]{2})[0-9]{12})\b/g,
  },
  { name: "EMAIL", pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
  {
    name: "PHONE_US",
    pattern: /\b(?:\+1[-.\s]?)?\(?[2-9]\d{2}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g,
  },
];

// Normalized (lowercased, separators stripped) field names whose values are always redacted.
const SENSITIVE_FIELDS = new Set([
  "password",
  "passwd",
  "pwd",
  "secret",
  "apikey",
  "apisecret",
  "token",
  "accesstoken",
  "refreshtoken",
  "authorization",
  "bearer",
  "credentials",
  "credential",
  "privatekey",
  "secretkey",
  "sessiontoken",
  "cookie",
  "cookies",
  "setcookie",
  "ssn",
  "socialsecuritynumber",
  "taxid",
  "creditcard",
  "cardnumber",
  "cvv",
  "cvc",
  "pin",
]);

const MAX_DEPTH = 20;
const MAX_STRING_LENGTH = 10_000;

export type SanitizationResult = {
  sanitized: unknown;
  redactionCount: number;
};

function isSensitiveField(key: string): boolean {
  return SENSITIVE_FIELDS.has(key.toLowerCase().replace(/[-_]/g, ""));
}

function sanitizeString(value: string): { result: string; count: number } {
  let result = value;
  let count = 0;
  for (const { name, pattern } of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(result)) {
      pattern.lastIndex = 0;
      result = result.replace(pattern, () => {
        count++;
        return `[REDACTED:${name}]`;
      });
    }
  }
  if (result.length > MAX_STRING_LENGTH) {
    result = result.substring(0, MAX_STRING_LENGTH) + "...[TRUNCATED]";
  }
  return { result, count };
}

function sanitizeValue(value: unknown, depth: number): { result: unknown; count: number } {
  if (depth > MAX_DEPTH || value === null || value === undefined) {
    return { result: value, count: 0 };
  }
  if (typeof value === "string") {
    return sanitizeString(value);
  }
  if (typeof value !== "object") {
    return { result: value, count: 0 };
  }

  if (Array.isArray(value)) {
    let total = 0;
    const items = value.map((item) => {
      const { result, count } = sanitizeValue(item, depth + 1);
      total += count;
      return result;
    });
    return { result: items, count: total };
  }

  let total = 0;
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    if (isSensitiveField(key)) {
      out[key] = "[REDACTED:SENSITIVE_FIELD]";
      total++;
      continue;
    }
    const { result, count } = sanitizeValue(val, depth + 1);
    out[key] = result;
    total += count;
  }
  return { result: out, count: total };
}

/**
 * Sanitize a value by redacting secrets, PII, and sensitive fields.
 * On error, fails closed by returning a safe placeholder.
 */
export function sanitize(data: unknown): SanitizationResult {
  try {
    const { result, count } = sanitizeValue(data, 0);
    return { sanitized: result, redactionCount: count };
  } catch {
    return { sanitized: "[SANITIZATION_ERROR]", redactionCount: 0 };
  }
}
