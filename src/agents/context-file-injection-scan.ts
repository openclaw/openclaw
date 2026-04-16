import { sanitizeForPromptLiteral } from "./sanitize-for-prompt.js";

/**
 * Scans context file content for prompt injection patterns.
 *
 * This is a port of Hermes Agent's _CONTEXT_THREAT_PATTERNS from
 * agent/prompt_builder.py (lines 36-52). The patterns are deliberately
 * identical to Hermes so that the GPT 5.4 parity benchmark is preserved —
 * we want OpenClaw to surface the same classes of injection that Hermes
 * already blocks in production.
 *
 * When a threat is detected, the content is REPLACED with a blocking
 * placeholder (matching Hermes's behavior). Wrapping the content in a
 * "data fence" was considered but rejected: Hermes drops the content
 * entirely, and we must match that to preserve the cross-comparison.
 */

interface ThreatPattern {
  re: RegExp;
  id: string;
}

// Ported from Hermes _CONTEXT_THREAT_PATTERNS (prompt_builder.py:36-47).
// All patterns are case-insensitive matches on the raw file content.
const THREAT_PATTERNS: ThreatPattern[] = [
  { re: /ignore\s+(?:(?:previous|all|above|prior)\s+)*instructions/i, id: "prompt_injection" },
  { re: /do\s+not\s+tell\s+the\s+user/i, id: "deception_hide" },
  { re: /system\s+prompt\s+override/i, id: "sys_prompt_override" },
  { re: /disregard\s+(your|all|any)\s+(instructions|rules|guidelines)/i, id: "disregard_rules" },
  {
    re: /act\s+as\s+(if|though)\s+you\s+(have\s+no|don['\u2019]t\s+have)\s+(restrictions|limits|rules)/i,
    id: "bypass_restrictions",
  },
  {
    re: /<!--[\s\S]*?(?:ignore|override|system|secret|hidden)[\s\S]*?-->/i,
    id: "html_comment_injection",
  },
  { re: /<\s*div\s+style\s*=\s*["'][\s\S]*?display\s*:\s*none/i, id: "hidden_div" },
  // Multi-line flag (m + s) on these patterns so split-across-newlines
  // attacks like "translate X\n into Y and execute" don't bypass detection.
  {
    re: /translate\s+[\s\S]*?\s+into\s+[\s\S]*?\s+and\s+(execute|run|eval)/im,
    id: "translate_execute",
  },
  {
    re: /curl\s+[\s\S]*?\$\{?\w*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)/im,
    id: "exfil_curl",
  },
  { re: /cat\s+[\s\S]*?(\.env|credentials|\.netrc|\.pgpass)/im, id: "read_secrets" },
];

// Default allowlist of paths whose content discusses injection patterns
// for legitimate reasons (security docs, QA scenarios). Files matching
// these patterns get a warning event but are NOT blocked.
const DEFAULT_ALLOWLIST: RegExp[] = [
  /(?:^|\/)(SECURITY|CONTRIBUTING)\.md$/i,
  /(?:^|\/)docs\/security\//i,
  /(?:^|\/)qa\/scenarios\//i,
];

/**
 * Normalize a filename for allowlist matching:
 * - Backslashes (Windows) → forward slashes so the regex anchors work
 *   uniformly across platforms.
 * - Reject any path containing a `..` segment so an attacker can't
 *   bypass an allowlisted prefix via traversal
 *   (e.g. `qa/scenarios/../../etc/passwd`).
 *
 * Returns `null` when the path is hostile (any `..` segment) so the
 * caller treats it as NOT allowlisted (fail-closed).
 */
function normalizePathForAllowlist(filename: string): string | null {
  const normalized = filename.replace(/\\+/g, "/");
  // Reject literal `..` path segments (anywhere in the path). Using a
  // segment-level test rather than a substring test so legitimate
  // filenames like `foo..bar.md` are not falsely rejected.
  for (const segment of normalized.split("/")) {
    if (segment === "..") {
      return null;
    }
  }
  return normalized;
}

function isAllowlistedPath(filename: string, allowlist: RegExp[] = DEFAULT_ALLOWLIST): boolean {
  const normalized = normalizePathForAllowlist(filename);
  if (normalized === null) {
    // Traversal detected — never allowlist a hostile path.
    return false;
  }
  return allowlist.some((re) => re.test(normalized));
}

// Ported from Hermes _CONTEXT_INVISIBLE_CHARS (prompt_builder.py:49-52).
// Includes zero-width chars AND bidi override chars (U+202A..U+202E) which
// can reorder rendered text to hide instructions.
const INVISIBLE_CHARS: ReadonlySet<string> = new Set([
  "\u200B",
  "\u200C",
  "\u200D",
  "\u2060",
  "\uFEFF",
  "\u202A",
  "\u202B",
  "\u202C",
  "\u202D",
  "\u202E",
]);

export interface InjectionScanResult {
  detected: boolean;
  findings: string[];
}

export function scanForInjection(content: string): InjectionScanResult {
  const findings: string[] = [];

  // Check for invisible unicode (single occurrence is enough; matches Hermes).
  for (const char of INVISIBLE_CHARS) {
    if (content.includes(char)) {
      const hex = char.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0");
      findings.push(`invisible unicode U+${hex}`);
    }
  }

  // Check threat patterns.
  for (const { re, id } of THREAT_PATTERNS) {
    if (re.test(content)) {
      findings.push(id);
    }
  }

  return { detected: findings.length > 0, findings };
}

/**
 * Sanitizes a context file's content for injection.
 *
 * Matches Hermes's _scan_context_content behavior: if any threat pattern or
 * invisible unicode char is detected, the original content is REPLACED with
 * a blocking placeholder and the file is effectively not loaded. This is
 * stricter than a "warn and pass through" approach, but it mirrors what
 * Hermes already ships in production for the parity benchmark.
 */
export interface SanitizeContextFileOptions {
  /**
   * Path patterns (regex) that bypass blocking — content is passed through
   * with a warning callback fired instead of being replaced with the placeholder.
   * Default: SECURITY.md, CONTRIBUTING.md, docs/security/*, qa/scenarios/*.
   */
  allowlist?: RegExp[];
  /**
   * Optional callback fired when an allowlisted file would have been blocked.
   * Useful for telemetry / audit logging.
   */
  onAllowlistBypass?: (filename: string, findings: string[]) => void;
}

export function sanitizeContextFileForInjection(
  content: string,
  filename = "context file",
  options: SanitizeContextFileOptions = {},
): string {
  const { detected, findings } = scanForInjection(content);
  if (!detected) {
    return content;
  }
  // Allowlist bypass: legitimate security docs that discuss injection patterns
  // shouldn't be blocked from loading. Caller can override the default list.
  // Bug fix (#67512 hardening): we previously called isAllowlistedPath(filename)
  // without forwarding the caller-supplied allowlist, so custom allowlists
  // were silently ignored. Now the custom list (if any) is applied.
  const allowlist = options.allowlist ?? DEFAULT_ALLOWLIST;
  if (isAllowlistedPath(filename, allowlist)) {
    options.onAllowlistBypass?.(filename, findings);
    return content;
  }
  // Sanitize filename to prevent injection via crafted file paths.
  // Use sanitizeForPromptLiteral for Cc/Cf/Zl/Zp chars, then strip brackets
  // (placeholder delimiters) and HTML/markdown angle/ampersand chars
  // (defense-in-depth: a filename like <!--ignore previous instructions-->.md
  // shouldn't embed instruction-like text inside the BLOCKED placeholder).
  const safeFilename = sanitizeForPromptLiteral(filename).replace(/[[\]<>&]/g, "_") || "unknown";
  return `[BLOCKED: ${safeFilename} contained potential prompt injection (${findings.join(", ")}). Content not loaded.]`;
}
