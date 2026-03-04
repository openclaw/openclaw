/**
 * ECC (Everything Claude Code) Integration Module
 * Provides security scanning, skill creation, and best practice enforcement
 */

import { z } from "zod";

// ============================================================================
// Security Scanner (AgentShield-inspired)
// ============================================================================

export const SecurityFindingSchema = z.object({
  id: z.string(),
  severity: z.enum(["critical", "high", "medium", "low", "info"]),
  category: z.enum([
    "secret-exposure",
    "injection-risk",
    "misconfiguration",
    "permission-issue",
    "dependency-risk",
    "pattern-violation",
  ]),
  file: z.string(),
  line: z.number().optional(),
  message: z.string(),
  suggestion: z.string().optional(),
  autoFixable: z.boolean(),
});

export type SecurityFinding = z.infer<typeof SecurityFindingSchema>;

export class SecurityScanner {
  private rules: SecurityRule[] = [];

  constructor() {
    this.initializeRules();
  }

  private initializeRules(): void {
    this.rules = [
      // Secret detection
      {
        id: "sec-001",
        name: "Hardcoded API Keys",
        pattern: /['"]?(?:api[_-]?key|apikey|api_token)['"]?\s*[:=]\s*['"][a-zA-Z0-9]{20,}['"]/i,
        severity: "critical",
        category: "secret-exposure",
        message: "Hardcoded API key detected",
        suggestion: "Use environment variables or secure secret management",
      },
      {
        id: "sec-002",
        name: "Private Keys",
        pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/,
        severity: "critical",
        category: "secret-exposure",
        message: "Private key found in source code",
        suggestion: "Remove immediately and rotate the key",
      },
      // Injection risks
      {
        id: "sec-003",
        name: "SQL Injection Risk",
        pattern: /(?:exec|query)\s*\(\s*[`"'].*\$\{.*\}/,
        severity: "high",
        category: "injection-risk",
        message: "Potential SQL injection via template literal",
        suggestion: "Use parameterized queries or prepared statements",
      },
      {
        id: "sec-004",
        name: "Command Injection",
        pattern: /(?:exec|spawn|execSync)\s*\(\s*[`"'].*\+/,
        severity: "high",
        category: "injection-risk",
        message: "Potential command injection via string concatenation",
        suggestion: "Use safe command execution with proper validation",
      },
      // Misconfigurations
      {
        id: "sec-005",
        name: "Debug Mode Enabled",
        pattern: /debug\s*:\s*true|DEBUG\s*=\s*true/i,
        severity: "medium",
        category: "misconfiguration",
        message: "Debug mode enabled",
        suggestion: "Disable debug mode in production",
      },
      {
        id: "sec-006",
        name: "Insecure CORS",
        pattern: /access-control-allow-origin['"]?\s*:\s*['"]\*/i,
        severity: "medium",
        category: "misconfiguration",
        message: "Permissive CORS configuration",
        suggestion: "Restrict CORS to specific origins",
      },
    ];
  }

  /**
   * Scan file content for security issues
   */
  scanFile(filePath: string, content: string): SecurityFinding[] {
    const findings: SecurityFinding[] = [];
    const lines = content.split("\n");

    for (const rule of this.rules) {
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        if (rule.pattern.test(line)) {
          findings.push({
            id: `${rule.id}-${findings.length}`,
            severity: rule.severity,
            category: rule.category,
            file: filePath,
            line: i + 1,
            message: rule.message,
            suggestion: rule.suggestion,
            autoFixable: false,
          });
        }
      }
    }

    return findings;
  }

  /**
   * Scan multiple files
   */
  async scanFiles(files: Array<{ path: string; content: string }>): Promise<ScanResult> {
    const allFindings: SecurityFinding[] = [];

    for (const file of files) {
      const findings = this.scanFile(file.path, file.content);
      allFindings.push(...findings);
    }

    // Sort by severity
    const severityOrder = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
    allFindings.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);

    return {
      findings: allFindings,
      summary: {
        critical: allFindings.filter((f) => f.severity === "critical").length,
        high: allFindings.filter((f) => f.severity === "high").length,
        medium: allFindings.filter((f) => f.severity === "medium").length,
        low: allFindings.filter((f) => f.severity === "low").length,
        info: allFindings.filter((f) => f.severity === "info").length,
        total: allFindings.length,
      },
      passed: allFindings.filter((f) => f.severity === "critical").length === 0,
    };
  }

  /**
   * Generate security report
   */
  generateReport(result: ScanResult): string {
    const lines: string[] = [
      "# Security Scan Report",
      "",
      `**Status:** ${result.passed ? "✅ PASSED" : "❌ FAILED"}`,
      "",
      "## Summary",
      `- Critical: ${result.summary.critical}`,
      `- High: ${result.summary.high}`,
      `- Medium: ${result.summary.medium}`,
      `- Low: ${result.summary.low}`,
      `- Info: ${result.summary.info}`,
      `- Total: ${result.summary.total}`,
      "",
    ];

    if (result.findings.length > 0) {
      lines.push("## Findings");
      lines.push("");

      for (const finding of result.findings) {
        lines.push(`### ${finding.id} (${finding.severity.toUpperCase()})`);
        lines.push(`- **File:** ${finding.file}${finding.line ? `:${finding.line}` : ""}`);
        lines.push(`- **Category:** ${finding.category}`);
        lines.push(`- **Message:** ${finding.message}`);
        if (finding.suggestion) {
          lines.push(`- **Suggestion:** ${finding.suggestion}`);
        }
        lines.push("");
      }
    }

    return lines.join("\n");
  }
}

// ============================================================================
// Skill Creator
// ============================================================================

export interface SkillDefinition {
  id: string;
  name: string;
  description: string;
  category: string;
  commands: string[];
  patterns: string[];
  examples: string[];
  prerequisites: string[];
}

export class SkillCreator {
  /**
   * Generate skill from code patterns
   */
  generateSkill(name: string, patterns: string[], examples: string[]): SkillDefinition {
    const id = `skill-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    // Infer category from patterns
    const category = this.inferCategory(patterns);

    // Generate commands based on category
    const commands = this.generateCommands(category, name);

    return {
      id,
      name: name.toLowerCase().replace(/\s+/g, "-"),
      description: `Auto-generated skill for ${name}`,
      category,
      commands,
      patterns,
      examples,
      prerequisites: this.inferPrerequisites(patterns),
    };
  }

  /**
   * Infer skill category from patterns
   */
  private inferCategory(patterns: string[]): string {
    const allPatterns = patterns.join(" ").toLowerCase();

    if (allPatterns.includes("test") || allPatterns.includes("spec")) {
      return "testing";
    }
    if (allPatterns.includes("deploy") || allPatterns.includes("infra")) {
      return "devops";
    }
    if (allPatterns.includes("security") || allPatterns.includes("scan")) {
      return "security";
    }
    if (allPatterns.includes("review") || allPatterns.includes("analyze")) {
      return "analysis";
    }
    if (allPatterns.includes("implement") || allPatterns.includes("code")) {
      return "development";
    }

    return "general";
  }

  /**
   * Generate commands for skill
   */
  private generateCommands(category: string, name: string): string[] {
    const baseCommands: Record<string, string[]> = {
      testing: [`/${name}-test`, `/${name}-coverage`, `/${name}-mock`],
      devops: [`/${name}-deploy`, `/${name}-build`, `/${name}-provision`],
      security: [`/${name}-scan`, `/${name}-audit`, `/${name}-harden`],
      analysis: [`/${name}-review`, `/${name}-analyze`, `/${name}-report`],
      development: [`/${name}-create`, `/${name}-refactor`, `/${name}-debug`],
      general: [`/${name}`, `/${name}-help`],
    };

    return baseCommands[category] || baseCommands.general;
  }

  /**
   * Infer prerequisites from patterns
   */
  private inferPrerequisites(patterns: string[]): string[] {
    const prereqs: string[] = [];
    const allPatterns = patterns.join(" ");

    if (allPatterns.includes("TypeScript") || allPatterns.includes(".ts")) {
      prereqs.push("typescript");
    }
    if (allPatterns.includes("React") || allPatterns.includes("JSX")) {
      prereqs.push("react");
    }
    if (allPatterns.includes("Node")) {
      prereqs.push("nodejs");
    }
    if (allPatterns.includes("Docker")) {
      prereqs.push("docker");
    }

    return prereqs;
  }

  /**
   * Export skill to SKILL.md format
   */
  exportToMarkdown(skill: SkillDefinition): string {
    const lines: string[] = [
      `# ${skill.name}`,
      "",
      skill.description,
      "",
      `**Category:** ${skill.category}`,
      "",
      "## Commands",
      "",
    ];

    for (const cmd of skill.commands) {
      lines.push(`- \`${cmd}\``);
    }

    if (skill.patterns.length > 0) {
      lines.push("", "## Patterns");
      lines.push("");
      for (const pattern of skill.patterns) {
        lines.push(`- ${pattern}`);
      }
    }

    if (skill.examples.length > 0) {
      lines.push("", "## Examples");
      lines.push("");
      for (const example of skill.examples) {
        lines.push("```");
        lines.push(example);
        lines.push("```");
        lines.push("");
      }
    }

    if (skill.prerequisites.length > 0) {
      lines.push("", "## Prerequisites");
      lines.push("");
      for (const prereq of skill.prerequisites) {
        lines.push(`- ${prereq}`);
      }
    }

    return lines.join("\n");
  }
}

// ============================================================================
// Best Practice Enforcer
// ============================================================================

export interface BestPractice {
  id: string;
  name: string;
  description: string;
  category: string;
  check: (content: string, filePath: string) => PracticeResult;
}

export interface PracticeResult {
  passed: boolean;
  message?: string;
  suggestions?: string[];
}

export class BestPracticeEnforcer {
  private practices: BestPractice[] = [];

  constructor() {
    this.initializePractices();
  }

  private initializePractices(): void {
    this.practices = [
      {
        id: "bp-001",
        name: "File Size Limit",
        description: "Keep files under 500 lines",
        category: "maintainability",
        check: (content: string) => {
          const lines = content.split("\n").length;
          return {
            passed: lines <= 500,
            message: lines > 500 ? `File has ${lines} lines (limit: 500)` : undefined,
            suggestions: lines > 500 ? ["Split into smaller modules"] : undefined,
          };
        },
      },
      {
        id: "bp-002",
        name: "TypeScript Strict",
        description: "Avoid using any type",
        category: "type-safety",
        check: (content: string) => {
          const anyCount = (content.match(/:\s*any\b/g) || []).length;
          return {
            passed: anyCount === 0,
            message: anyCount > 0 ? `Found ${anyCount} 'any' types` : undefined,
            suggestions: ["Use specific types or unknown instead of any"],
          };
        },
      },
      {
        id: "bp-003",
        name: "Documentation",
        description: "Public APIs should have JSDoc comments",
        category: "documentation",
        check: (content: string) => {
          const publicExports = (
            content.match(/export\s+(?:async\s+)?function|export\s+class/g) || []
          ).length;
          const jsdocComments = (content.match(/\/\*\*[\s\S]*?\*\//g) || []).length;

          return {
            passed: jsdocComments >= publicExports * 0.8, // 80% coverage
            message:
              jsdocComments < publicExports
                ? `Missing JSDoc: ${publicExports - jsdocComments} exports need documentation`
                : undefined,
          };
        },
      },
      {
        id: "bp-004",
        name: "Error Handling",
        description: "Functions should handle errors appropriately",
        category: "robustness",
        check: (content: string) => {
          const hasTryCatch = content.includes("try") && content.includes("catch");
          const hasAsync = content.includes("async");

          return {
            passed: !hasAsync || hasTryCatch,
            message:
              hasAsync && !hasTryCatch ? "Async functions should have try-catch blocks" : undefined,
          };
        },
      },
    ];
  }

  /**
   * Check file against best practices
   */
  checkFile(filePath: string, content: string): PracticeCheckResult {
    const results: Array<{ practice: BestPractice; result: PracticeResult }> = [];

    for (const practice of this.practices) {
      const result = practice.check(content, filePath);
      results.push({ practice, result });
    }

    const passed = results.every((r) => r.result.passed);
    const failed = results.filter((r) => !r.result.passed);

    return {
      file: filePath,
      passed,
      total: this.practices.length,
      passed_count: results.filter((r) => r.result.passed).length,
      failed: failed.map((r) => ({
        id: r.practice.id,
        name: r.practice.name,
        message: r.result.message,
        suggestions: r.result.suggestions,
      })),
    };
  }
}

// Type definitions
interface SecurityRule {
  id: string;
  name: string;
  pattern: RegExp;
  severity: "critical" | "high" | "medium" | "low" | "info";
  category:
    | "secret-exposure"
    | "injection-risk"
    | "misconfiguration"
    | "permission-issue"
    | "dependency-risk"
    | "pattern-violation";
  message: string;
  suggestion?: string;
}

interface ScanResult {
  findings: SecurityFinding[];
  summary: {
    critical: number;
    high: number;
    medium: number;
    low: number;
    info: number;
    total: number;
  };
  passed: boolean;
}

interface PracticeCheckResult {
  file: string;
  passed: boolean;
  total: number;
  passed_count: number;
  failed: Array<{
    id: string;
    name: string;
    message?: string;
    suggestions?: string[];
  }>;
}

export type { PracticeCheckResult };
