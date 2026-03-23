#!/usr/bin/env bun
/**
 * Auto-Fix Verification Script
 *
 * Cross-references open/merged GitHub issues (labeled auto-improve+platform)
 * against recent session diagnostics to verify if fixes worked.
 *
 * Usage:
 *   bun .claude/skills/auto-fix/scripts/check-fixes.ts [--issue N] [--json]
 *
 * Options:
 *   --issue N   Check a specific issue number
 *   --json      Output as JSON instead of human-readable
 */

import { execSync } from "child_process";
import { readFileSync, existsSync } from "fs";
import { homedir } from "os";
import { join, resolve } from "path";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const FIXES_TSV = resolve(join(homedir(), "dev/operator1/.claude/skills/auto-fix/data/fixes.tsv"));
const SCORE_SCRIPT = resolve(
  join(homedir(), "dev/operator1/.claude/skills/auto-improve/scripts/score.ts"),
);

// ---------------------------------------------------------------------------
// Parse args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
function getArg(name: string, defaultVal: string): string {
  const idx = args.indexOf(`--${name}`);
  if (idx === -1 || idx + 1 >= args.length) return defaultVal;
  return args[idx + 1];
}
const hasFlag = (name: string) => args.includes(`--${name}`);

const ISSUE_FILTER = getArg("issue", "");
const OUTPUT_JSON = hasFlag("json");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface FixEntry {
  issue: string;
  category: string;
  severity: string;
  pr: string;
  status: string;
  error_signature: string;
  files_changed: string;
  description: string;
}

interface DiagnosticIssue {
  category: string;
  severity: string;
  agent: string;
  session_id: string;
  timestamp: string;
  tool_name: string;
  error_signature: string;
  evidence: string;
  suggested_labels: string[];
}

interface VerificationResult {
  issue: string;
  error_signature: string;
  still_present: boolean;
  current_status: string;
  recommendation: "close" | "reopen" | "keep-open" | "no-data";
  evidence: string;
}

// ---------------------------------------------------------------------------
// Load fixes.tsv
// ---------------------------------------------------------------------------

function loadFixes(): FixEntry[] {
  if (!existsSync(FIXES_TSV)) return [];

  const raw = readFileSync(FIXES_TSV, "utf-8");
  const lines = raw.split("\n").filter((l) => l.trim());
  if (lines.length < 2) return []; // header only

  const header = lines[0].split("\t");
  return lines.slice(1).map((line) => {
    const cols = line.split("\t");
    const entry: Record<string, string> = {};
    header.forEach((h, i) => {
      entry[h] = cols[i] || "";
    });
    return entry as unknown as FixEntry;
  });
}

// ---------------------------------------------------------------------------
// Get current diagnostics
// ---------------------------------------------------------------------------

function getCurrentDiagnostics(): DiagnosticIssue[] {
  try {
    const output = execSync(`bun ${SCORE_SCRIPT} --diagnostics`, {
      encoding: "utf-8",
      timeout: 30000,
    });
    return JSON.parse(output);
  } catch {
    console.error("Failed to run diagnostics. Is score.ts available?");
    return [];
  }
}

// ---------------------------------------------------------------------------
// Verify fixes
// ---------------------------------------------------------------------------

function verifyFixes(): VerificationResult[] {
  const fixes = loadFixes();
  const diagnostics = getCurrentDiagnostics();
  const results: VerificationResult[] = [];

  // Get active error signatures from diagnostics
  const activeSignatures = new Set(diagnostics.map((d) => d.error_signature));

  // Filter fixes to check
  const toCheck = ISSUE_FILTER
    ? fixes.filter((f) => f.issue === ISSUE_FILTER)
    : fixes.filter((f) => f.status === "merged" || f.status === "pr-open");

  for (const fix of toCheck) {
    const stillPresent = activeSignatures.has(fix.error_signature);
    let recommendation: VerificationResult["recommendation"];
    let evidence: string;

    if (fix.status === "pr-open") {
      recommendation = "keep-open";
      evidence = "PR not yet merged — waiting for review.";
    } else if (fix.status === "merged") {
      if (stillPresent) {
        recommendation = "reopen";
        evidence = `Error signature still detected in recent sessions after merge. Fix may be incomplete.`;
      } else {
        recommendation = "close";
        evidence = `Error signature no longer detected in ${diagnostics.length > 0 ? diagnostics.length : "recent"} sessions. Fix verified.`;
      }
    } else {
      recommendation = "no-data";
      evidence = `Fix status is "${fix.status}" — no verification needed.`;
    }

    results.push({
      issue: fix.issue,
      error_signature: fix.error_signature,
      still_present: stillPresent,
      current_status: fix.status,
      recommendation,
      evidence,
    });
  }

  // Also check: are there active diagnostics with no corresponding fix?
  for (const diag of diagnostics) {
    const hasFixAttempt = fixes.some((f) => f.error_signature === diag.error_signature);
    if (!hasFixAttempt && diag.severity === "high") {
      results.push({
        issue: "none",
        error_signature: diag.error_signature,
        still_present: true,
        current_status: "unfixed",
        recommendation: "keep-open",
        evidence: `High-severity issue with no fix attempt: ${diag.evidence}`,
      });
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

function printTable(results: VerificationResult[]) {
  if (results.length === 0) {
    console.log("No fixes to verify.");
    return;
  }

  console.log("=== Fix Verification Results ===\n");
  console.log(
    "Issue".padEnd(8) +
      "Status".padEnd(12) +
      "Present".padEnd(10) +
      "Action".padEnd(14) +
      "Evidence",
  );
  console.log("-".repeat(80));

  for (const r of results) {
    console.log(
      `#${r.issue}`.padEnd(8) +
        r.current_status.padEnd(12) +
        (r.still_present ? "YES" : "no").padEnd(10) +
        r.recommendation.padEnd(14) +
        r.evidence.slice(0, 60),
    );
  }
  console.log("");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const results = verifyFixes();

  if (OUTPUT_JSON) {
    console.log(JSON.stringify(results, null, 2));
  } else {
    printTable(results);
  }
}

main();
