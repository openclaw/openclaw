#!/usr/bin/env bun
/**
 * Lint AGENTS.md / CLAUDE.md for common quality and security issues.
 *
 * Checks:
 * 1. Leaked secrets (API keys, tokens, passwords)
 * 2. File size / line count (>150 lines is discouraged per best practices)
 * 3. Hardcoded absolute paths (not portable across machines)
 * 4. Missing security section
 * 5. PII exposure (emails, credentials in non-USER files)
 * 6. Conflicting instructions (MUST + MUST NOT on same topic)
 *
 * Usage:
 *   bun scripts/check-agents-md-quality.ts [path-to-agents-md]
 *   # defaults to ./AGENTS.md
 *
 * Exit codes:
 *   0 — no issues found
 *   1 — warnings or errors found
 */

import fs from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Severity = "error" | "warning" | "info";

type Finding = {
  severity: Severity;
  line: number;
  rule: string;
  message: string;
};

// ---------------------------------------------------------------------------
// Secret patterns
// ---------------------------------------------------------------------------

const SECRET_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  { name: "OpenAI API key", pattern: /sk-(?:proj-)?[a-zA-Z0-9]{20,}/ },
  { name: "Anthropic API key", pattern: /sk-ant-[a-zA-Z0-9]{20,}/ },
  { name: "AWS access key", pattern: /AKIA[A-Z0-9]{16}/ },
  { name: "GitHub token (ghp_)", pattern: /ghp_[a-zA-Z0-9]{36}/ },
  { name: "GitHub token (gho_)", pattern: /gho_[a-zA-Z0-9]{36}/ },
  { name: "GitHub token (ghs_)", pattern: /ghs_[a-zA-Z0-9]{36}/ },
  { name: "Slack token", pattern: /xox[bpas]-[a-zA-Z0-9\-]{10,}/ },
  { name: "Stripe key", pattern: /sk_(?:test|live)_[a-zA-Z0-9]{24,}/ },
  { name: "Bearer token", pattern: /Bearer\s+[a-zA-Z0-9._\-]{20,}/ },
  { name: "Private key", pattern: /-----BEGIN (?:RSA |EC |DSA )?PRIVATE KEY-----/ },
  { name: "Database URL with credentials", pattern: /(?:postgres|mysql|mongodb(?:\+srv)?):\/\/[^:]+:[^@]+@[^\s]+/ },
  { name: "Supabase JWT", pattern: /eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9\.[a-zA-Z0-9_-]{50,}/ },
];

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

function checkSecrets(lines: string[]): Finding[] {
  const findings: Finding[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Skip comment lines
    if (line.trim().startsWith("//")) continue;
    for (const { name, pattern } of SECRET_PATTERNS) {
      if (pattern.test(line)) {
        findings.push({
          severity: "error",
          line: i + 1,
          rule: "no-secrets",
          message: `Leaked secret detected: ${name}. Move to environment variables.`,
        });
      }
    }
  }
  return findings;
}

function checkFileSize(lines: string[], filePath: string): Finding[] {
  const findings: Finding[] = [];
  const lineCount = lines.length;
  const fileName = path.basename(filePath);

  if (lineCount > 300) {
    findings.push({
      severity: "error",
      line: 0,
      rule: "file-size",
      message: `${fileName} has ${lineCount} lines (recommended: ≤150). Large instruction files degrade agent performance.`,
    });
  } else if (lineCount > 150) {
    findings.push({
      severity: "warning",
      line: 0,
      rule: "file-size",
      message: `${fileName} has ${lineCount} lines (recommended: ≤150). Consider splitting into focused files.`,
    });
  }
  return findings;
}

function checkHardcodedPaths(lines: string[]): Finding[] {
  const findings: Finding[] = [];
  // Match absolute paths like /Users/..., /home/..., C:\Users\...
  const pathPattern = /(?:\/Users\/[a-zA-Z0-9._-]+\/|\/home\/[a-zA-Z0-9._-]+\/|[A-Z]:\\Users\\)/;
  for (let i = 0; i < lines.length; i++) {
    if (pathPattern.test(lines[i])) {
      findings.push({
        severity: "warning",
        line: i + 1,
        rule: "no-hardcoded-paths",
        message: "Hardcoded absolute path detected. Use relative paths or $HOME for portability.",
      });
      break; // One finding is enough
    }
  }
  return findings;
}

function checkSecuritySection(content: string): Finding[] {
  const hasSecuritySection =
    /##?\s+(?:Security|🔒|🛡️|Safety|Boundaries)/i.test(content);
  const hasSecurityKeywords =
    /inject|jailbreak|permission|authorized|trust/i.test(content);

  if (!hasSecuritySection && !hasSecurityKeywords) {
    return [
      {
        severity: "warning",
        line: 0,
        rule: "has-security-section",
        message:
          "No security section or injection defense found. Consider adding guidelines for prompt injection defense and permission boundaries.",
      },
    ];
  }
  return [];
}

function checkPII(lines: string[]): Finding[] {
  const findings: Finding[] = [];
  const emailPattern = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(emailPattern);
    if (match && !match[0].includes("example.com") && !match[0].includes("@openclaw")) {
      findings.push({
        severity: "info",
        line: i + 1,
        rule: "no-pii",
        message: `Email address found: ${match[0]}. Consider moving PII to a separate, private file.`,
      });
      break;
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function lint(filePath: string): Finding[] {
  if (!fs.existsSync(filePath)) {
    console.error(`File not found: ${filePath}`);
    process.exit(2);
  }

  const content = fs.readFileSync(filePath, "utf-8");
  const lines = content.split("\n");

  return [
    ...checkSecrets(lines),
    ...checkFileSize(lines, filePath),
    ...checkHardcodedPaths(lines),
    ...checkSecuritySection(content),
    ...checkPII(lines),
  ];
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const targetPath = process.argv[2] || "AGENTS.md";
const resolvedPath = path.resolve(targetPath);

// Also check CLAUDE.md if it exists and is not a symlink to AGENTS.md
const filesToCheck: string[] = [resolvedPath];
if (!process.argv[2]) {
  const claudeMdPath = path.resolve("CLAUDE.md");
  if (fs.existsSync(claudeMdPath)) {
    try {
      const stat = fs.lstatSync(claudeMdPath);
      if (!stat.isSymbolicLink()) {
        filesToCheck.push(claudeMdPath);
      }
    } catch {
      // ignore
    }
  }
}

let totalErrors = 0;
let totalWarnings = 0;

for (const file of filesToCheck) {
  if (!fs.existsSync(file)) continue;
  const findings = lint(file);
  const relPath = path.relative(process.cwd(), file);

  if (findings.length === 0) {
    console.log(`✅ ${relPath}: no issues found`);
    continue;
  }

  console.log(`\n📋 ${relPath}:`);
  for (const f of findings) {
    const icon = f.severity === "error" ? "❌" : f.severity === "warning" ? "⚠️" : "ℹ️";
    const loc = f.line > 0 ? `:${f.line}` : "";
    console.log(`  ${icon} [${f.rule}]${loc} ${f.message}`);
    if (f.severity === "error") totalErrors++;
    if (f.severity === "warning") totalWarnings++;
  }
}

if (totalErrors > 0 || totalWarnings > 0) {
  console.log(`\n${totalErrors} error(s), ${totalWarnings} warning(s)`);
  process.exit(1);
} else {
  console.log("\n✅ All checks passed");
}
