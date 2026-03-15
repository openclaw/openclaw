/**
 * Secret leak detection for tool output.
 *
 * Scans text for known API key and credential patterns.
 * Matches are redacted to prevent secrets from reaching the LLM.
 */

export type LeakMatch = {
  ruleId: string;
  message: string;
  /** Redacted evidence: first 4 chars + masked remainder */
  evidence: string;
};

type LeakRule = {
  id: string;
  message: string;
  pattern: RegExp;
};

const LEAK_RULES: LeakRule[] = [
  // ── API keys ────────────────────────────────────────────────────
  {
    id: "openai-key",
    message: "OpenAI API key",
    pattern: /\bsk-proj-[A-Za-z0-9_-]{20,}/g,
  },
  {
    id: "openai-key-legacy",
    message: "OpenAI API key (legacy)",
    pattern: /\bsk-[A-Za-z0-9]{40,}/g,
  },
  {
    id: "anthropic-key",
    message: "Anthropic API key",
    pattern: /\bsk-ant-api[A-Za-z0-9_-]{20,}/g,
  },
  {
    id: "google-api-key",
    message: "Google API key",
    pattern: /\bAIza[A-Za-z0-9_-]{35}\b/g,
  },
  {
    id: "github-pat",
    message: "GitHub personal access token",
    pattern: /\b(ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{50,})\b/g,
  },
  {
    id: "github-oauth",
    message: "GitHub OAuth token",
    pattern: /\bgho_[A-Za-z0-9]{36}\b/g,
  },
  {
    id: "aws-access-key",
    message: "AWS access key",
    pattern: /\bAKIA[A-Z0-9]{16}\b/g,
  },
  {
    id: "aws-secret-key",
    message: "AWS secret key",
    pattern:
      /(?:aws_secret_access_key|AWS_SECRET_ACCESS_KEY|SecretAccessKey)\s*[:=]\s*['"]?([A-Za-z0-9/+=]{40})['"]?/g,
  },
  {
    id: "stripe-key",
    message: "Stripe API key",
    pattern: /\b(sk_live_|pk_live_|rk_live_)[A-Za-z0-9]{20,}/g,
  },
  {
    id: "slack-token",
    message: "Slack token",
    pattern: /\bxox[bpras]-[A-Za-z0-9-]{10,}/g,
  },
  {
    id: "slack-webhook",
    message: "Slack webhook URL",
    pattern: /https:\/\/hooks\.slack\.com\/services\/T[A-Z0-9]+\/B[A-Z0-9]+\/[A-Za-z0-9]+/g,
  },
  {
    id: "telegram-bot-token",
    message: "Telegram bot token",
    pattern: /\b[0-9]{8,10}:[A-Za-z0-9_-]{35}\b/g,
  },
  {
    id: "twilio-key",
    message: "Twilio API key",
    pattern: /\bSK[a-f0-9]{32}\b/g,
  },
  {
    id: "sendgrid-key",
    message: "SendGrid API key",
    pattern: /\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}\b/g,
  },
  {
    id: "heroku-key",
    message: "Heroku API key",
    pattern:
      /(?:HEROKU_API_KEY|heroku_api_key)\s*[:=]\s*['"]?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})['"]?/gi,
  },
  {
    id: "deepseek-key",
    message: "DeepSeek API key",
    pattern: /\bsk-[a-f0-9]{32,}\b/g,
  },

  // ── Private keys and certificates ───────────────────────────────
  {
    id: "private-key-pem",
    message: "PEM private key",
    pattern:
      /-----BEGIN (RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----[\s\S]*?-----END (RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g,
  },

  // ── Passwords and tokens in URLs ────────────────────────────────
  {
    id: "url-credentials",
    message: "Credentials embedded in URL",
    pattern: /https?:\/\/[^:]+:[^@]+@[a-zA-Z0-9.-]+/g,
  },
  {
    id: "bearer-token",
    message: "Bearer token in plain text",
    pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}\b/g,
  },

  // ── Generic high-entropy secrets ────────────────────────────────
  {
    id: "generic-api-key-assignment",
    message: "API key assignment pattern",
    pattern:
      /(?:api[_-]?key|api[_-]?secret|access[_-]?token|secret[_-]?key)\s*[:=]\s*['"][A-Za-z0-9_/+=-]{16,}['"]/gi,
  },
];

/**
 * Scan text for potential secret leaks.
 * Returns matched rules with redacted evidence.
 */
export function scanForLeaks(text: string): LeakMatch[] {
  const matches: LeakMatch[] = [];
  const seen = new Set<string>();

  for (const rule of LEAK_RULES) {
    // Reset lastIndex for global regexps
    rule.pattern.lastIndex = 0;

    let match;
    while ((match = rule.pattern.exec(text)) !== null) {
      const value = match[0];
      const key = `${rule.id}:${value.slice(0, 8)}`;
      if (seen.has(key)) continue;
      seen.add(key);

      matches.push({
        ruleId: rule.id,
        message: rule.message,
        evidence: redactValue(value),
      });
    }
  }

  return matches;
}

/**
 * Redact all detected secrets in the text, replacing them with [REDACTED:ruleId].
 * Returns the cleaned text.
 */
export function redactLeaks(text: string): string {
  let result = text;

  for (const rule of LEAK_RULES) {
    rule.pattern.lastIndex = 0;
    result = result.replace(rule.pattern, `[REDACTED:${rule.id}]`);
  }

  return result;
}

/** Show first 4 characters then mask the rest. */
function redactValue(value: string): string {
  if (value.length <= 8) return "****";
  return value.slice(0, 4) + "*".repeat(Math.min(value.length - 4, 20));
}
