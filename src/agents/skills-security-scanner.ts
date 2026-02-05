import fs from "node:fs";
import path from "node:path";
import type { SkillEntry } from "./skills.js";

export type SecurityRiskLevel = "low" | "medium" | "high" | "critical";

export type SecurityIssue = {
  type: "file_access" | "network" | "code_pattern" | "permission" | "dependency";
  severity: SecurityRiskLevel;
  message: string;
  details?: string;
  file?: string;
  line?: number;
};

export type SecurityScanResult = {
  riskLevel: SecurityRiskLevel;
  issues: SecurityIssue[];
  score: number; // 0-100, where 0 is safest
  passed: boolean; // Whether it passes the configured security policy
};

type SecurityPolicy = "strict" | "moderate" | "permissive";

const RISK_WEIGHTS: Record<SecurityRiskLevel, number> = {
  low: 5,
  medium: 20,
  high: 50,
  critical: 100,
};

// Sensitive file patterns that indicate potential security risks
const SENSITIVE_PATHS = [
  /\.ssh/i,
  /\.aws/i,
  /\.netrc/i,
  /\.npmrc/i,
  /\.env/,
  /password/i,
  /secret/i,
  /token/i,
  /credential/i,
  /\/etc\/passwd/,
  /\/etc\/shadow/,
  /\.bash_history/,
  /\.zsh_history/,
];

// High-risk function patterns in code
const DANGEROUS_PATTERNS = [
  { pattern: /\beval\s*\(/gi, severity: "critical" as SecurityRiskLevel, message: "Uses eval()" },
  { pattern: /\bexec\s*\(/gi, severity: "high" as SecurityRiskLevel, message: "Uses exec()" },
  {
    pattern: /\bchild_process\b/gi,
    severity: "high" as SecurityRiskLevel,
    message: "Uses child_process",
  },
  {
    pattern: /\bshell_exec\b/gi,
    severity: "critical" as SecurityRiskLevel,
    message: "Uses shell_exec",
  },
  {
    pattern: /\bsystem\s*\(/gi,
    severity: "critical" as SecurityRiskLevel,
    message: "Uses system()",
  },
  {
    pattern: /base64.*decode|atob\s*\(/gi,
    severity: "medium" as SecurityRiskLevel,
    message: "Uses base64 decoding (potential obfuscation)",
  },
  {
    pattern: /\bcurl\s+.*\|\s*bash/gi,
    severity: "critical" as SecurityRiskLevel,
    message: "Pipes curl output to bash",
  },
  {
    pattern: /\bwget\s+.*\|\s*sh/gi,
    severity: "critical" as SecurityRiskLevel,
    message: "Pipes wget output to shell",
  },
  {
    pattern: /\brm\s+-rf\s+[~/]/gi,
    severity: "critical" as SecurityRiskLevel,
    message: "Recursive file deletion",
  },
];

// Network activity patterns
const NETWORK_PATTERNS = [
  {
    pattern: /https?:\/\/(?!(?:www\.)?(?:github\.com|npmjs\.com|pypi\.org)(?:\/|$))/gi,
    severity: "medium" as SecurityRiskLevel,
    message: "External network connection",
  },
  {
    pattern: /\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/g,
    severity: "high" as SecurityRiskLevel,
    message: "IP address detected (possible C2 server)",
  },
];

/**
 * Calculate overall risk level from issues
 */
function calculateRiskLevel(issues: SecurityIssue[]): SecurityRiskLevel {
  if (issues.some((i) => i.severity === "critical")) {
    return "critical";
  }
  if (issues.some((i) => i.severity === "high")) {
    return "high";
  }
  if (issues.some((i) => i.severity === "medium")) {
    return "medium";
  }
  return "low";
}

/**
 * Calculate numeric risk score (0-100)
 */
function calculateRiskScore(issues: SecurityIssue[]): number {
  const totalScore = issues.reduce((sum, issue) => {
    return sum + RISK_WEIGHTS[issue.severity];
  }, 0);
  return Math.min(100, totalScore);
}

/**
 * Check if file path contains sensitive patterns
 */
function scanForSensitivePaths(content: string, filePath: string): SecurityIssue[] {
  const issues: SecurityIssue[] = [];
  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const pattern of SENSITIVE_PATHS) {
      // Create a new regex instance to avoid stateful .test() issues with global flags
      const testPattern = new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, ""));
      if (testPattern.test(line)) {
        issues.push({
          type: "file_access",
          severity: "high",
          message: "Accesses sensitive file path",
          details: `Pattern: ${pattern.source}`,
          file: filePath,
          line: i + 1,
        });
      }
    }
  }

  return issues;
}

/**
 * Scan for dangerous code patterns
 */
function scanForDangerousPatterns(content: string, filePath: string): SecurityIssue[] {
  const issues: SecurityIssue[] = [];
  const lines = content.split("\n");

  for (const { pattern, severity, message } of DANGEROUS_PATTERNS) {
    const matches = [...content.matchAll(pattern)];
    for (const match of matches) {
      // Find line number
      const beforeMatch = content.slice(0, match.index);
      const lineNumber = beforeMatch.split("\n").length;

      issues.push({
        type: "code_pattern",
        severity,
        message,
        details: `Found: ${match[0]}`,
        file: filePath,
        line: lineNumber,
      });
    }
  }

  return issues;
}

/**
 * Scan for network activity
 */
function scanForNetworkActivity(content: string, filePath: string): SecurityIssue[] {
  const issues: SecurityIssue[] = [];

  for (const { pattern, severity, message } of NETWORK_PATTERNS) {
    const matches = [...content.matchAll(pattern)];
    for (const match of matches) {
      const beforeMatch = content.slice(0, match.index);
      const lineNumber = beforeMatch.split("\n").length;

      issues.push({
        type: "network",
        severity,
        message,
        details: `Found: ${match[0]}`,
        file: filePath,
        line: lineNumber,
      });
    }
  }

  return issues;
}

/**
 * Scan a single file for security issues
 */
async function scanFile(filePath: string): Promise<SecurityIssue[]> {
  try {
    const content = await fs.promises.readFile(filePath, "utf-8");
    const issues: SecurityIssue[] = [];

    issues.push(...scanForSensitivePaths(content, filePath));
    issues.push(...scanForDangerousPatterns(content, filePath));
    issues.push(...scanForNetworkActivity(content, filePath));

    return issues;
  } catch (err) {
    // If we can't read the file, skip it
    return [];
  }
}

/**
 * Recursively scan directory for security issues
 */
async function scanDirectory(dirPath: string, maxDepth = 5): Promise<SecurityIssue[]> {
  if (maxDepth <= 0) {
    return [];
  }

  const issues: SecurityIssue[] = [];

  try {
    const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);

      // Skip node_modules and hidden directories
      if (entry.name === "node_modules" || entry.name.startsWith(".")) {
        continue;
      }

      if (entry.isDirectory()) {
        const subIssues = await scanDirectory(fullPath, maxDepth - 1);
        issues.push(...subIssues);
      } else if (entry.isFile()) {
        // Only scan text files
        const ext = path.extname(entry.name).toLowerCase();
        const textExtensions = [
          ".ts",
          ".js",
          ".mjs",
          ".py",
          ".sh",
          ".bash",
          ".md",
          ".json",
          ".yaml",
          ".yml",
          ".txt",
        ];
        if (textExtensions.includes(ext) || entry.name === "SKILL.md") {
          const fileIssues = await scanFile(fullPath);
          issues.push(...fileIssues);
        }
      }
    }
  } catch (err) {
    // Ignore read errors
  }

  return issues;
}

/**
 * Assess permissions requested by skill
 */
function assessPermissions(entry: SkillEntry): SecurityIssue[] {
  const issues: SecurityIssue[] = [];
  const metadata = entry.metadata;

  if (!metadata) {
    return issues;
  }

  // Check for exec tool access
  const tools = metadata.tools ?? [];
  if (tools.includes("Exec") || tools.includes("Bash")) {
    issues.push({
      type: "permission",
      severity: "high",
      message: "Requests exec/bash tool access",
      details: "Can execute arbitrary shell commands",
    });
  }

  // Check for file write access
  if (tools.includes("Write") || tools.includes("Edit")) {
    issues.push({
      type: "permission",
      severity: "medium",
      message: "Requests file write access",
      details: "Can modify files on disk",
    });
  }

  // Check for network tools
  if (tools.includes("WebFetch") || tools.includes("Browser")) {
    issues.push({
      type: "permission",
      severity: "low",
      message: "Requests network access",
      details: "Can make external HTTP requests",
    });
  }

  return issues;
}

/**
 * Check if scan result passes the configured security policy
 */
function passesPolicy(result: SecurityScanResult, policy: SecurityPolicy): boolean {
  switch (policy) {
    case "strict":
      // Strict: Block high and critical
      return result.riskLevel !== "high" && result.riskLevel !== "critical";
    case "moderate":
      // Moderate: Block only critical
      return result.riskLevel !== "critical";
    case "permissive":
      // Permissive: Warn only, always pass
      return true;
    default:
      return true;
  }
}

/**
 * Main security scan function for a skill entry
 */
export async function scanSkillSecurity(
  entry: SkillEntry,
  policy: SecurityPolicy = "moderate",
): Promise<SecurityScanResult> {
  const issues: SecurityIssue[] = [];

  // 1. Assess permissions
  issues.push(...assessPermissions(entry));

  // 2. Scan skill directory for code issues
  const skillDir = path.dirname(entry.filePath);
  const codeIssues = await scanDirectory(skillDir);
  issues.push(...codeIssues);

  // 3. Calculate risk
  const riskLevel = calculateRiskLevel(issues);
  const score = calculateRiskScore(issues);
  const passed = passesPolicy({ riskLevel, issues, score, passed: false }, policy);

  return {
    riskLevel,
    issues,
    score,
    passed,
  };
}

/**
 * Format security scan result for display
 */
export function formatSecurityScanResult(result: SecurityScanResult): string {
  const lines: string[] = [];

  const icon =
    result.riskLevel === "low"
      ? "🟢"
      : result.riskLevel === "medium"
        ? "🟡"
        : result.riskLevel === "high"
          ? "🔴"
          : "🚨";

  lines.push(`${icon} Risk Level: ${result.riskLevel.toUpperCase()} (Score: ${result.score}/100)`);
  lines.push("");

  if (result.issues.length === 0) {
    lines.push("No security issues detected.");
    return lines.join("\n");
  }

  lines.push(`Detected ${result.issues.length} issue(s):`);
  lines.push("");

  // Group issues by severity
  const critical = result.issues.filter((i) => i.severity === "critical");
  const high = result.issues.filter((i) => i.severity === "high");
  const medium = result.issues.filter((i) => i.severity === "medium");
  const low = result.issues.filter((i) => i.severity === "low");

  const formatIssues = (issues: SecurityIssue[], label: string) => {
    if (issues.length === 0) return;
    lines.push(`${label}:`);
    for (const issue of issues) {
      const location = issue.file ? ` (${issue.file}:${issue.line ?? "?"})` : "";
      lines.push(`  • ${issue.message}${location}`);
      if (issue.details) {
        lines.push(`    ${issue.details}`);
      }
    }
    lines.push("");
  };

  formatIssues(critical, "🚨 CRITICAL");
  formatIssues(high, "🔴 HIGH");
  formatIssues(medium, "🟡 MEDIUM");
  formatIssues(low, "🟢 LOW");

  return lines.join("\n");
}
