/**
 * Dangerous command detection for tool call parameters.
 *
 * Scans shell commands, file paths, and tool arguments for patterns
 * that could cause irreversible damage to the host system.
 */

export type DangerousMatch = {
  ruleId: string;
  severity: "critical" | "warn";
  message: string;
  evidence: string;
};

type Rule = {
  id: string;
  severity: "critical" | "warn";
  message: string;
  pattern: RegExp;
};

/**
 * Rules are checked against stringified tool parameters.
 * Each pattern uses word boundaries or context to reduce false positives.
 */
const RULES: Rule[] = [
  // ── Destructive file operations ─────────────────────────────────
  {
    id: "rm-recursive",
    severity: "critical",
    message: "Recursive file deletion detected",
    pattern: /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f|--recursive|-[a-zA-Z]*f[a-zA-Z]*r)\b/,
  },
  {
    id: "rm-force-root",
    severity: "critical",
    message: "Forced removal of root or home directory",
    pattern:
      /\brm\s+-[a-zA-Z]*f[a-zA-Z]*\s+(\/\s|\/\*|~\/|\/etc|\/usr|\/var|\/boot|\/home|\/root)\b/,
  },
  {
    id: "mkfs",
    severity: "critical",
    message: "Filesystem format command detected",
    pattern: /\bmkfs(\.[a-z0-9]+)?\s/,
  },
  {
    id: "dd-if-dev",
    severity: "critical",
    message: "Raw disk write (dd) detected",
    pattern: /\bdd\s+.*\bof=\/dev\//,
  },
  {
    id: "shred",
    severity: "critical",
    message: "Secure file shredding detected",
    pattern: /\bshred\b/,
  },

  // ── Permission / ownership abuse ────────────────────────────────
  {
    id: "chmod-777",
    severity: "warn",
    message: "World-writable permission change",
    pattern: /\bchmod\s+(-[a-zA-Z]*\s+)?777\b/,
  },
  {
    id: "chmod-suid",
    severity: "critical",
    message: "Set-UID/Set-GID permission change",
    pattern: /\bchmod\s+(-[a-zA-Z]*\s+)?[2467][0-7]{3}\b/,
  },
  {
    id: "chown-root",
    severity: "warn",
    message: "Ownership change to root detected",
    pattern: /\bchown\s+(-[a-zA-Z]*\s+)?root\b/,
  },

  // ── Remote code execution ───────────────────────────────────────
  {
    id: "curl-pipe-bash",
    severity: "critical",
    message: "Remote script piped to shell",
    pattern: /\b(curl|wget)\s.*\|\s*(bash|sh|zsh|dash|sudo)\b/,
  },
  {
    id: "eval-exec",
    severity: "warn",
    message: "Dynamic code execution in shell",
    pattern: /\b(eval|exec)\s+["`$]/,
  },

  // ── System disruption ───────────────────────────────────────────
  {
    id: "shutdown-reboot",
    severity: "critical",
    message: "System shutdown or reboot command",
    pattern: /\b(shutdown|reboot|poweroff|halt|init\s+[06])\b/,
  },
  {
    id: "kill-all",
    severity: "warn",
    message: "Mass process kill detected",
    pattern: /\b(killall|pkill\s+-9|kill\s+-9\s+-1)\b/,
  },
  {
    id: "fork-bomb",
    severity: "critical",
    message: "Fork bomb pattern detected",
    pattern: /:\(\)\{\s*:\|:&\s*\};:/,
  },

  // ── Sensitive path access ───────────────────────────────────────
  {
    id: "ssh-key-access",
    severity: "critical",
    message: "Access to SSH private keys",
    pattern: /[/~]\.ssh\/(id_rsa|id_ed25519|id_ecdsa|id_dsa|authorized_keys)\b/,
  },
  {
    id: "sensitive-dir-write",
    severity: "warn",
    message: "Write to sensitive system directory",
    pattern: /\b(>|>>|tee|cp|mv|install)\s+.*\/(etc|boot|usr\/sbin|var\/log)\//,
  },
  {
    id: "aws-credentials",
    severity: "critical",
    message: "Access to AWS credentials file",
    pattern: /[/~]\.aws\/(credentials|config)\b/,
  },
  {
    id: "env-file-access",
    severity: "warn",
    message: "Access to .env file",
    pattern: /\.(env|env\.local|env\.production)\b/,
  },

  // ── Network exfiltration ────────────────────────────────────────
  {
    id: "reverse-shell",
    severity: "critical",
    message: "Reverse shell pattern detected",
    pattern: /\bbash\s+-i\s+>&|\/dev\/tcp\/|\bnc\s+-[a-z]*e\b/,
  },
  {
    id: "base64-decode-pipe",
    severity: "warn",
    message: "Base64 decode piped to execution",
    pattern: /\bbase64\s+(-d|--decode)\s*\|\s*(bash|sh|python|node|perl)\b/,
  },

  // ── Crypto mining ───────────────────────────────────────────────
  {
    id: "crypto-miner",
    severity: "critical",
    message: "Cryptocurrency mining detected",
    pattern: /\b(stratum\+tcp|xmrig|coinhive|cryptonight|minerd)\b/i,
  },
];

/**
 * Scan a stringified tool call for dangerous patterns.
 * Returns all matching rules sorted by severity (critical first).
 */
export function scanForDangerousCommands(input: string): DangerousMatch[] {
  const matches: DangerousMatch[] = [];

  for (const rule of RULES) {
    const match = rule.pattern.exec(input);
    if (match) {
      matches.push({
        ruleId: rule.id,
        severity: rule.severity,
        message: rule.message,
        evidence: match[0].slice(0, 120),
      });
    }
  }

  // Critical first
  matches.sort(
    (a, b) => (a.severity === "critical" ? -1 : 1) - (b.severity === "critical" ? -1 : 1),
  );
  return matches;
}
