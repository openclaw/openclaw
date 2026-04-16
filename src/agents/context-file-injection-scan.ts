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
  { re: /ignore\s+(previous|all|above|prior)\s+instructions/i, id: "prompt_injection" },
  { re: /do\s+not\s+tell\s+the\s+user/i, id: "deception_hide" },
  { re: /system\s+prompt\s+override/i, id: "sys_prompt_override" },
  { re: /disregard\s+(your|all|any)\s+(instructions|rules|guidelines)/i, id: "disregard_rules" },
  {
    re: /act\s+as\s+(if|though)\s+you\s+(have\s+no|don['\u2019]t\s+have)\s+(restrictions|limits|rules)/i,
    id: "bypass_restrictions",
  },
  { re: /<!--[^>]*(?:ignore|override|system|secret|hidden)[^>]*-->/i, id: "html_comment_injection" },
  { re: /<\s*div\s+style\s*=\s*["'][\s\S]*?display\s*:\s*none/i, id: "hidden_div" },
  { re: /translate\s+.*\s+into\s+.*\s+and\s+(execute|run|eval)/i, id: "translate_execute" },
  {
    re: /curl\s+[^\n]*\$\{?\w*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)/i,
    id: "exfil_curl",
  },
  { re: /cat\s+[^\n]*(\.env|credentials|\.netrc|\.pgpass)/i, id: "read_secrets" },
];

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
export function sanitizeContextFileForInjection(
  content: string,
  filename = "context file",
): string {
  const { detected, findings } = scanForInjection(content);
  if (!detected) {
    return content;
  }
  // Sanitize filename to prevent injection via crafted file paths.
  const safeFilename = filename.replace(/[\[\]\n\r]/g, "_");
  return `[BLOCKED: ${safeFilename} contained potential prompt injection (${findings.join(", ")}). Content not loaded.]`;
}
