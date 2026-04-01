import type { ScanPattern, ScanFinding, ScanResult, ThreatLevel } from "./types.js";

const THREAT_ORDER: Record<ThreatLevel, number> = {
  none: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

const DEFAULT_PATTERNS: ScanPattern[] = [
  // Prompt injection
  {
    name: "role_override",
    regex:
      /\b(you are|act as|ignore previous|disregard|forget)\b.*\b(instructions|rules|system)\b/i,
    threat: "high",
  },
  {
    name: "delimiter_escape",
    regex: /(<\/?system>|<\|im_start\|>|<\|im_end\|>|\[INST\]|\[\/INST\])/i,
    threat: "critical",
  },
  {
    name: "invisible_unicode",
    regex: /[\u200B-\u200F\u2028-\u202F\uFEFF\u00AD]/,
    threat: "medium",
  },

  // Exfiltration
  {
    name: "curl_exfil",
    regex: /\b(curl|wget|fetch|axios)\b.*\b(memory|credentials|api.?key|token|secret)\b/i,
    threat: "critical",
  },
  {
    name: "base64_exfil",
    regex: /\b(btoa|atob|base64)\b.*\b(memory|key|secret|token)\b/i,
    threat: "high",
  },
  {
    name: "dns_exfil",
    regex: /\b(dig|nslookup|host)\b.*\.(burp|oast|interact|dnsbin)\./i,
    threat: "critical",
  },

  // Data extraction
  {
    name: "env_dump",
    regex: /\b(process\.env|os\.environ|\$ENV|printenv)\b/i,
    threat: "medium",
  },
  {
    name: "file_exfil",
    regex: /\b(\/etc\/passwd|\/etc\/shadow|\.ssh\/|\.aws\/|\.env)\b/,
    threat: "high",
  },
];

export class InjectionScanner {
  private patterns: ScanPattern[];

  constructor(extraPatterns?: ScanPattern[]) {
    this.patterns = [...DEFAULT_PATTERNS, ...(extraPatterns ?? [])];
  }

  scan(text: string): ScanResult {
    const findings: ScanFinding[] = [];

    for (const pattern of this.patterns) {
      const match = pattern.regex.exec(text);
      if (match) {
        findings.push({
          pattern: pattern.name,
          threat: pattern.threat,
          match: match[0],
          position: match.index,
          context: text.slice(Math.max(0, match.index - 50), match.index + match[0].length + 50),
        });
      }
    }

    const highestThreat = findings.reduce<ThreatLevel>(
      (max, f) => (THREAT_ORDER[f.threat] > THREAT_ORDER[max] ? f.threat : max),
      "none",
    );

    return { clean: findings.length === 0, findings, highestThreat };
  }
}
