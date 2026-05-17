// Strips secret-shaped strings from agent output before it hits any channel.
// Patterns are ordered most-specific first so we catch the obvious stuff
// before the generic key=value catch-all kicks in.

import type { SecretPattern } from "../types.js";

const REDACTED = "[REDACTED]";

export const SECRET_PATTERNS: readonly SecretPattern[] = Object.freeze([
  // Cloud providers
  { name: "AWS Access Key ID", pattern: /\bAKIA[0-9A-Z]{16}\b/g, replacement: `AWS_KEY=${REDACTED}` },
  { name: "AWS Secret Key", pattern: /(?:aws_secret_access_key|AWS_SECRET)\s*[=:]\s*["']?[A-Za-z0-9/+=]{40}["']?/gi, replacement: `AWS_SECRET=${REDACTED}` },
  { name: "GCP Service Account", pattern: /\b[0-9]+-[a-z0-9]+@[a-z-]+\.iam\.gserviceaccount\.com\b/g, replacement: `GCP_SA=${REDACTED}` },

  // Vendor API keys
  { name: "OpenAI API Key", pattern: /\bsk-[A-Za-z0-9]{20,}\b/g, replacement: `OPENAI_KEY=${REDACTED}` },
  { name: "Anthropic API Key", pattern: /\bsk-ant-[A-Za-z0-9_\-]{20,}\b/g, replacement: `ANTHROPIC_KEY=${REDACTED}` },
  { name: "GitHub Token", pattern: /\bgh[ps]_[A-Za-z0-9_]{36,}\b/g, replacement: `GITHUB_TOKEN=${REDACTED}` },
  { name: "Slack Token", pattern: /\bxox[baprs]-[0-9a-zA-Z\-]+\b/g, replacement: `SLACK_TOKEN=${REDACTED}` },
  { name: "Stripe Key", pattern: /\b[sr]k_(?:live|test)_[A-Za-z0-9]{20,}\b/g, replacement: `STRIPE_KEY=${REDACTED}` },
  { name: "Twilio Auth Token", pattern: /\b[0-9a-f]{32}\b(?=.*twilio)/gi, replacement: `TWILIO_TOKEN=${REDACTED}` },
  { name: "SendGrid API Key", pattern: /\bSG\.[A-Za-z0-9_\-]{22}\.[A-Za-z0-9_\-]{43}\b/g, replacement: `SENDGRID_KEY=${REDACTED}` },
  { name: "Mailgun API Key", pattern: /\bkey-[a-z0-9]{32}\b/g, replacement: `MAILGUN_KEY=${REDACTED}` },

  // Auth tokens
  { name: "Bearer Token", pattern: /Bearer\s+[A-Za-z0-9_\-.]{20,}/g, replacement: `Bearer ${REDACTED}` },
  { name: "JWT Token", pattern: /\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_\-.]+\b/g, replacement: `JWT=${REDACTED}` },

  // Private keys
  { name: "Private Key", pattern: /-----BEGIN\s+(?:RSA\s+|DSA\s+|EC\s+|OPENSSH\s+)?PRIVATE\s+KEY-----[\s\S]*?-----END\s+(?:RSA\s+|DSA\s+|EC\s+|OPENSSH\s+)?PRIVATE\s+KEY-----/g, replacement: `[PRIVATE KEY ${REDACTED}]` },

  // DB connection strings
  { name: "Database URL", pattern: /(?:postgres|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^\s"'`]{10,}/gi, replacement: `DB_URL=${REDACTED}` },

  // Generic catch-alls (run last; higher false-positive rate)
  { name: "Generic API Key Assignment", pattern: /(?:api[_-]?key|apikey|api_secret|access_token|auth_token)\s*[=:]\s*["']?[A-Za-z0-9_\-./+=]{16,}["']?/gi, replacement: `API_KEY=${REDACTED}` },
  { name: "Password Assignment", pattern: /(?:password|passwd|pwd)\s*[=:]\s*["']?[^\s"']{8,}["']?/gi, replacement: `PASSWORD=${REDACTED}` },
]);

export function redactSecrets(text: string): { redacted: string; count: number } {
  let result = text;
  let count = 0;

  for (const { pattern, replacement } of SECRET_PATTERNS) {
    pattern.lastIndex = 0;

    const before = result;
    result = result.replace(pattern, replacement);
    if (result !== before) {
      pattern.lastIndex = 0;
      const matches = before.match(pattern);
      count += matches ? matches.length : 1;
    }
  }

  return { redacted: result, count };
}

// Non-mutating check.
export function containsSecrets(text: string): boolean {
  for (const { pattern } of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(text)) return true;
  }
  return false;
}
