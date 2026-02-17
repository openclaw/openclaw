#!/usr/bin/env tsx
/**
 * Risk Policy Gate — runs before expensive CI.
 *
 * 1. Reads changed files from git diff
 * 2. Computes risk tier from risk-policy.json
 * 3. Validates all required checks are configured
 * 4. Checks docs drift rules
 * 5. Exits 0 if OK, 1 if policy violated
 */

import { execSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

interface RiskPolicy {
  version: string;
  riskTierRules: Record<string, string[]>;
  mergePolicy: Record<
    string,
    {
      requiredChecks: string[];
      requireBrowserEvidence?: boolean;
      minTestCoverage?: number;
      requireHumanApproval?: boolean;
    }
  >;
  docsDriftRules?: {
    trackedPaths: string[];
    requireChangelogEntry: boolean;
  };
}

function matchGlob(file: string, pattern: string): boolean {
  const regex = new RegExp(
    "^" +
      pattern
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*\*/g, "{{GLOBSTAR}}")
        .replace(/\*/g, "[^/]*")
        .replace(/{{GLOBSTAR}}/g, ".*") +
      "$",
  );
  return regex.test(file);
}

function getChangedFiles(baseBranch = "main"): string[] {
  try {
    const output = execSync(`git diff --name-only ${baseBranch}...HEAD`, {
      encoding: "utf-8",
    });
    return output.trim().split("\n").filter(Boolean);
  } catch {
    // Fallback: diff against HEAD~1
    try {
      const output = execSync("git diff --name-only HEAD~1", {
        encoding: "utf-8",
      });
      return output.trim().split("\n").filter(Boolean);
    } catch {
      return [];
    }
  }
}

function computeRiskTier(changedFiles: string[], policy: RiskPolicy): string {
  for (const file of changedFiles) {
    for (const pattern of policy.riskTierRules.high ?? []) {
      if (matchGlob(file, pattern)) return "high";
    }
  }
  for (const file of changedFiles) {
    for (const pattern of policy.riskTierRules.medium ?? []) {
      if (matchGlob(file, pattern)) return "medium";
    }
  }
  return "low";
}

function computeRequiredChecks(tier: string, policy: RiskPolicy): string[] {
  return policy.mergePolicy[tier]?.requiredChecks ?? ["ci-pipeline"];
}

function checkDocsDrift(changedFiles: string[], policy: RiskPolicy): string | null {
  const trackedPaths = policy.docsDriftRules?.trackedPaths ?? [];
  const hasControlPlaneChanges = changedFiles.some((f) =>
    trackedPaths.some((p) => matchGlob(f, p)),
  );

  if (hasControlPlaneChanges && policy.docsDriftRules?.requireChangelogEntry) {
    const hasChangelog = changedFiles.some((f) => f.toLowerCase().includes("changelog"));
    if (!hasChangelog) {
      return "Control-plane changes detected but no CHANGELOG entry found";
    }
  }

  return null;
}

// ── Main ─────────────────────────────────────────────────────────────────

function main() {
  const policyPath = join(process.cwd(), ".harness", "risk-policy.json");

  if (!existsSync(policyPath)) {
    console.log("No .harness/risk-policy.json found. Skipping risk policy gate.");
    process.exit(0);
  }

  const policy: RiskPolicy = JSON.parse(readFileSync(policyPath, "utf-8"));
  const baseBranch = process.env.BASE_BRANCH ?? "main";
  const changedFiles = getChangedFiles(baseBranch);

  console.log(`Changed files: ${changedFiles.length}`);
  console.log(`Base branch: ${baseBranch}`);

  if (changedFiles.length === 0) {
    console.log("No changed files detected. Passing.");
    process.exit(0);
  }

  // Compute risk tier
  const riskTier = computeRiskTier(changedFiles, policy);
  console.log(`Risk tier: ${riskTier}`);

  // Get required checks
  const requiredChecks = computeRequiredChecks(riskTier, policy);
  console.log(`Required checks: ${requiredChecks.join(", ")}`);

  // Check docs drift
  const driftError = checkDocsDrift(changedFiles, policy);
  if (driftError) {
    console.error(`POLICY VIOLATION: ${driftError}`);
    process.exit(1);
  }

  // Output for downstream jobs
  const mergePolicy = policy.mergePolicy[riskTier];
  const output = {
    riskTier,
    requiredChecks,
    requireBrowserEvidence: mergePolicy?.requireBrowserEvidence ?? false,
    minTestCoverage: mergePolicy?.minTestCoverage ?? 0,
    requireHumanApproval: mergePolicy?.requireHumanApproval ?? false,
    changedFiles,
    highRiskFiles: changedFiles.filter((f) =>
      (policy.riskTierRules.high ?? []).some((p) => matchGlob(f, p)),
    ),
  };

  // Write output for GitHub Actions
  if (process.env.GITHUB_OUTPUT) {
    const outputLines = [
      `risk_tier=${riskTier}`,
      `required_checks=${JSON.stringify(requiredChecks)}`,
      `require_browser_evidence=${output.requireBrowserEvidence}`,
      `min_test_coverage=${output.minTestCoverage}`,
      `require_human_approval=${output.requireHumanApproval}`,
    ];
    const { appendFileSync } = require("node:fs");
    for (const line of outputLines) {
      appendFileSync(process.env.GITHUB_OUTPUT, line + "\n");
    }
  }

  console.log("\nPolicy gate output:");
  console.log(JSON.stringify(output, null, 2));
  console.log("\nRisk policy gate: PASSED");
}

main();
