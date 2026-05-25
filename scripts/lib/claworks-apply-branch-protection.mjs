/**
 * GitHub branch protection helpers — dry-run by default; maintainer applies with gh api.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");

export const DEFAULT_PROTECTION_PATH = join(
  repoRoot,
  ".github/branch-protection/claworks-main.json",
);

export function loadBranchProtectionConfig(configPath = DEFAULT_PROTECTION_PATH) {
  const raw = readFileSync(configPath, "utf8");
  return JSON.parse(raw);
}

export function buildBranchProtectionApiPath({ owner, repo, branch }) {
  return `/repos/${owner}/${repo}/branches/${encodeURIComponent(branch)}/protection`;
}

export function formatProtectionPlan({ owner, repo, branch, config }) {
  const checks = config.required_status_checks?.contexts ?? [];
  const lines = [
    `Repository: ${owner}/${repo}`,
    `Branch: ${branch}`,
    `Required checks (${checks.length}): ${checks.join(", ") || "(none)"}`,
    `Strict (up to date): ${config.required_status_checks?.strict ? "yes" : "no"}`,
    `Reviews required: ${config.required_pull_request_reviews?.required_approving_review_count ?? 0}`,
  ];
  return lines.join("\n");
}
