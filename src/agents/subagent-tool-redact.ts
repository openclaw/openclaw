/**
 * Redact sensitive fragments from tool call/result payloads before we persist them
 * into the subagent transcript. Applied unconditionally on the write path so that
 * downstream chat.history consumers never see raw credentials, even if the display
 * layer forgets to sanitize.
 *
 * Rules are ordered so that broad block patterns (PEM blobs) run first, then line
 * based header/cookie rules, then key=value rules.
 */

export const REDACT_TOKEN = "[REDACTED]";

export const DEFAULT_TOOL_SUMMARY_MAX_LEN = 200;
export const DEFAULT_TOOL_RESULT_MAX_LEN = 500;

type RedactionRule = { pattern: RegExp; replacement: string };

const REDACTION_RULES: RedactionRule[] = [
  // Block: PEM/SSH private key blobs (-----BEGIN ...-----/-----END ...-----).
  {
    pattern: /-----BEGIN [A-Z ]+-----[\s\S]+?-----END [A-Z ]+-----/g,
    replacement: REDACT_TOKEN,
  },
  // Header: Authorization: <value> (entire line up to newline)
  {
    pattern: /Authorization:\s*[^\r\n]+/gi,
    replacement: `Authorization: ${REDACT_TOKEN}`,
  },
  // Bearer <token>
  {
    pattern: /Bearer\s+\S+/g,
    replacement: `Bearer ${REDACT_TOKEN}`,
  },
  // Header: Set-Cookie: <value>
  {
    pattern: /Set-Cookie:\s*[^\r\n]+/gi,
    replacement: `Set-Cookie: ${REDACT_TOKEN}`,
  },
  // Header: Cookie: <value>
  {
    pattern: /Cookie:\s*[^\r\n]+/gi,
    replacement: `Cookie: ${REDACT_TOKEN}`,
  },
  // OpenSSH public key line: `ssh-ed25519 AAAA...`
  {
    pattern: /ssh-[a-z0-9-]+ AAAA[A-Za-z0-9+/=]+/g,
    replacement: REDACT_TOKEN,
  },
  {
    pattern: /ssh [a-z0-9-]+ AAAA[A-Za-z0-9+/=]+/g,
    replacement: REDACT_TOKEN,
  },
  // key=value / "key": "value" (api_key, api-key, apikey, token, password, secret, passwd).
  // Keep the key name; replace the value with [REDACTED].
  {
    pattern: /(api[_-]?key|token|password|secret|passwd)([=:"\s]+)(\S+)/gi,
    replacement: `$1$2${REDACT_TOKEN}`,
  },
];

export function redactToolFragment(text: string, maxLen: number): string {
  if (typeof text !== "string" || text.length === 0) {
    return "";
  }
  let result = text;
  for (const rule of REDACTION_RULES) {
    result = result.replace(rule.pattern, rule.replacement);
  }
  const safeMaxLen = Math.max(1, Math.floor(maxLen));
  if (result.length > safeMaxLen) {
    result = `${result.slice(0, safeMaxLen)}…`;
  }
  return result;
}

export const TOOL_SUMMARY_PREFIX_RE = /^\[tool:\s*[^\]]+\]/;
export const TOOL_RESULT_SUMMARY_PREFIX = "[result]";

export function buildToolSummaryText(toolName: string, rawInput: unknown): string {
  const name = typeof toolName === "string" && toolName.trim() ? toolName.trim() : "unknown";
  let inputJson: string;
  try {
    inputJson = rawInput === undefined ? "" : JSON.stringify(rawInput);
  } catch {
    inputJson = JSON.stringify(rawInput ?? "");
  }
  const redacted = redactToolFragment(inputJson ?? "", DEFAULT_TOOL_SUMMARY_MAX_LEN);
  return `[tool: ${name}] ${redacted}`.trimEnd();
}

export function buildToolResultSummaryText(rawText: string | undefined | null): string {
  const safeText = typeof rawText === "string" ? rawText : "";
  const redacted = redactToolFragment(safeText, DEFAULT_TOOL_RESULT_MAX_LEN);
  return `${TOOL_RESULT_SUMMARY_PREFIX} ${redacted}`.trimEnd();
}

/**
 * Feature flag. Defaults to ON (no env / unrecognised value → enabled).
 * Env values "0" / "false" / "off" disable persistence.
 */
export function isSubagentPersistToolFragmentsEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const raw = env.SUBAGENT_PERSIST_TOOL_FRAGMENTS;
  if (raw == null) {
    return true;
  }
  const normalized = String(raw).trim().toLowerCase();
  if (!normalized) {
    return true;
  }
  if (normalized === "0" || normalized === "false" || normalized === "off" || normalized === "no") {
    return false;
  }
  return true;
}
