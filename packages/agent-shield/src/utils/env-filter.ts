// MCP subprocesses inherit our env by default, which means every API key
// in the operator's shell is handed to any npx/uvx package they install.
// This builds a stripped-down env for child_process.spawn that only carries
// what the subprocess actually needs.

import type { AgentShieldConfig } from "../types.js";

// Always allowed (exact match, case-sensitive on the key).
const ALWAYS_ALLOWED: readonly string[] = [
  "PATH",
  "HOME",
  "SHELL",
  "USER",
  "LOGNAME",
  "LANG",
  "TERM",
  "TMPDIR",
  "TMP",
  "TEMP",
  "NODE_PATH",
  "PYTHONPATH",
  "NODE_ENV",
];

const ALLOWED_PREFIXES: readonly string[] = [
  "XDG_",
  "LC_",
];

// Never let these through, even if someone added them to allowedEnvVars.
const BLOCKED_PATTERNS: readonly RegExp[] = [
  /^(?:AWS_SECRET|AWS_ACCESS)/i,
  /(?:API[_-]?KEY|API[_-]?SECRET|AUTH[_-]?TOKEN|ACCESS[_-]?TOKEN)/i,
  /^(?:ANTHROPIC|OPENAI|GOOGLE|AZURE|MISTRAL|COHERE|HUGGING)/i,
  /(?:PASSWORD|PASSWD|PRIVATE[_-]?KEY|SECRET[_-]?KEY)/i,
  /^(?:DATABASE[_-]?URL|REDIS[_-]?URL|MONGO[_-]?URI)/i,
  /^(?:STRIPE|TWILIO|SENDGRID|MAILGUN)/i,
  /^(?:GH[PS]_TOKEN|GITHUB_TOKEN|GITLAB_TOKEN)/i,
  /^(?:SLACK_TOKEN|SLACK_BOT_TOKEN|SLACK_WEBHOOK)/i,
  /^(?:npm_config_)/i,
];

export function buildSafeEnv(
  parentEnv: Record<string, string | undefined>,
  config: AgentShieldConfig,
  declaredVars: string[] = []
): Record<string, string> {
  const safeEnv: Record<string, string> = {};
  const allowed = new Set([
    ...ALWAYS_ALLOWED,
    ...config.allowedEnvVars,
    ...declaredVars,
  ]);

  for (const [key, value] of Object.entries(parentEnv)) {
    if (value === undefined) continue;
    if (isBlocked(key)) continue;

    if (allowed.has(key)) {
      safeEnv[key] = value;
      continue;
    }

    const upperKey = key.toUpperCase();
    if (ALLOWED_PREFIXES.some((prefix) => upperKey.startsWith(prefix))) {
      safeEnv[key] = value;
      continue;
    }
  }

  return safeEnv;
}

function isBlocked(name: string): boolean {
  return BLOCKED_PATTERNS.some((pat) => pat.test(name));
}

// For audit logging - what got dropped.
export function getFilterSummary(
  parentEnv: Record<string, string | undefined>,
  safeEnv: Record<string, string>
): { passed: number; filtered: number; filteredNames: string[] } {
  const allKeys = Object.keys(parentEnv).filter(
    (k) => parentEnv[k] !== undefined
  );
  const passedKeys = new Set(Object.keys(safeEnv));
  const filteredNames = allKeys.filter((k) => !passedKeys.has(k));

  return {
    passed: passedKeys.size,
    filtered: filteredNames.length,
    filteredNames,
  };
}
