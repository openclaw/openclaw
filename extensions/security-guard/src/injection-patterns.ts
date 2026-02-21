/**
 * Prompt Injection Detection Patterns
 *
 * 50+ patterns organized by threat category.
 * Ported from openclaw-security-guard by Miloud Belarebia.
 *
 * @see https://github.com/miloudbelarebia/openclaw-security-guard
 * @author Miloud Belarebia <https://2pidata.com>
 * @license MIT
 */

export type InjectionCategory = {
  name: string;
  severity: "critical" | "high" | "medium" | "low";
  description: string;
  patterns: RegExp[];
};

export const INJECTION_PATTERNS: InjectionCategory[] = [
  // Direct instruction override
  {
    name: "Instruction Override",
    severity: "critical",
    description: "Attempts to override system instructions",
    patterns: [
      /ignore\s+(all\s+)?(previous|prior|above)\s+(instructions?|rules?|guidelines?)/gi,
      /disregard\s+(all\s+)?(previous|prior|above)/gi,
      /forget\s+(everything|all)\s+(you\s+)?(know|learned|were\s+told)/gi,
      /new\s+instructions?:\s*/gi,
      /override\s+(previous\s+)?instructions?/gi,
      /system\s*:\s*you\s+are\s+now/gi,
    ],
  },

  // Role hijacking
  {
    name: "Role Hijacking",
    severity: "high",
    description: "Attempts to change the AI's role or personality",
    patterns: [
      /you\s+are\s+(now\s+)?(a|an|the)\s+\w+\s+(that|who|which)/gi,
      /pretend\s+(to\s+be|you\s+are)/gi,
      /act\s+as\s+(if\s+you\s+are|a|an)/gi,
      /roleplay\s+as/gi,
      /from\s+now\s+on[,\s]+you\s+are/gi,
      /switch\s+(to\s+)?(a\s+)?different\s+(mode|personality|character)/gi,
    ],
  },

  // Data exfiltration
  {
    name: "Data Exfiltration",
    severity: "critical",
    description: "Attempts to send data to external services",
    patterns: [
      /send\s+(this|the|all)\s+.*(to|via)\s+(email|http|url|webhook)/gi,
      /post\s+(this|the|data)\s+to\s+(https?:\/\/|api\.)/gi,
      /exfiltrate/gi,
      /upload\s+(this|the|all)\s+.*(to|via)/gi,
      /leak\s+(this|the|all)/gi,
      /forward\s+(all|this)\s+.*(to|via)/gi,
    ],
  },

  // Privilege escalation
  {
    name: "Privilege Escalation",
    severity: "critical",
    description: "Attempts to gain elevated privileges",
    patterns: [
      /as\s+(root|admin|administrator)/gi,
      /with\s+(elevated|admin|root)\s+(privileges?|permissions?|access)/gi,
      /bypass\s+(security|authentication|authorization)/gi,
      /disable\s+(security|protection|safeguards?)/gi,
      /turn\s+off\s+(safety|protection|filters?)/gi,
    ],
  },

  // System prompt extraction
  {
    name: "System Prompt Extraction",
    severity: "medium",
    description: "Attempts to extract system prompts",
    patterns: [
      /what\s+(are|is)\s+your\s+(system\s+)?(instructions?|prompt|rules?)/gi,
      /show\s+(me\s+)?(your\s+)?(system\s+)?(prompt|instructions?)/gi,
      /print\s+(your\s+)?(system\s+)?(prompt|instructions?)/gi,
      /reveal\s+(your\s+)?(system\s+)?(prompt|instructions?)/gi,
      /repeat\s+(the\s+)?(system\s+)?(prompt|instructions?)\s+(back|to\s+me)/gi,
      /output\s+(your|the)\s+(initial|system)\s+(prompt|instructions?)/gi,
    ],
  },

  // Jailbreak patterns
  {
    name: "Jailbreak Attempt",
    severity: "high",
    description: "Known jailbreak techniques",
    patterns: [
      /DAN\s+(mode|prompt)/gi,
      /developer\s+mode\s+(enabled|on|activate)/gi,
      /in\s+a\s+fictional\s+(scenario|world|story)/gi,
      /for\s+(educational|research)\s+purposes\s+only/gi,
      /this\s+is\s+just\s+a\s+(test|experiment|hypothetical)/gi,
      /no\s+(ethical|moral)\s+(guidelines?|restrictions?|limits?)/gi,
    ],
  },

  // Delimiter manipulation
  {
    name: "Delimiter Manipulation",
    severity: "critical",
    description: "Attempts to inject system-level delimiters",
    patterns: [
      /\[\[SYSTEM\]\]/gi,
      /\{\{SYSTEM\}\}/gi,
      /<\|system\|>/gi,
      /<\|im_start\|>/gi,
      /<\|im_end\|>/gi,
      /###\s*SYSTEM/gi,
      /---\s*BEGIN\s*SYSTEM/gi,
      /\[INST\]/gi,
      /<s>\s*\[INST\]/gi,
    ],
  },

  // Encoding bypass
  {
    name: "Encoding Bypass",
    severity: "medium",
    description: "Attempts to bypass filters using encoding",
    patterns: [
      /base64\s+(decode|encoded)/gi,
      /rot13/gi,
      /hex\s+(decode|encoded)/gi,
      /url\s*(decode|encoded)/gi,
      /unicode\s+(escape|encoded)/gi,
    ],
  },

  // Tool manipulation
  {
    name: "Tool Manipulation",
    severity: "high",
    description: "Attempts to manipulate tool usage",
    patterns: [
      /use\s+the\s+\w+\s+tool\s+to\s+(delete|remove|destroy)/gi,
      /invoke\s+(the\s+)?\w+\s+(tool|function)\s+without\s+(asking|confirmation)/gi,
      /automatically\s+(run|call)\s+(all\s+)?(tools?|functions?)/gi,
    ],
  },
];

/**
 * Check a message against all injection patterns.
 * Returns detected threats with severity info.
 */
export function detectInjection(
  content: string,
  sensitivity: "low" | "medium" | "high" = "medium",
): {
  safe: boolean;
  threats: Array<{
    category: string;
    severity: string;
    description: string;
    match: string;
  }>;
  shouldBlock: boolean;
} {
  const severityFilter: Record<string, string[]> = {
    low: ["critical"],
    medium: ["critical", "high"],
    high: ["critical", "high", "medium"],
  };

  const allowedSeverities = severityFilter[sensitivity] ?? ["critical", "high"];
  const threats: Array<{
    category: string;
    severity: string;
    description: string;
    match: string;
  }> = [];

  for (const category of INJECTION_PATTERNS) {
    if (!allowedSeverities.includes(category.severity)) continue;

    for (const pattern of category.patterns) {
      // Clone to avoid lastIndex issues with global patterns
      const regex = new RegExp(pattern.source, pattern.flags);
      const match = regex.exec(content);
      if (match) {
        threats.push({
          category: category.name,
          severity: category.severity,
          description: category.description,
          match: match[0],
        });
        break; // One match per category is enough
      }
    }
  }

  return {
    safe: threats.length === 0,
    threats,
    shouldBlock: threats.some((t) => t.severity === "critical"),
  };
}
