#!/usr/bin/env node
/**
 * Apply ClaWorks required status checks to a GitHub branch (maintainer-only).
 *
 * Default is dry-run. Requires `gh` authenticated with admin on the target repo.
 *
 * Usage:
 *   pnpm claworks:branch-protection              # print plan
 *   pnpm claworks:branch-protection --list-checks
 *   pnpm claworks:branch-protection --apply      # PUT via gh api
 *
 * Config: .github/branch-protection/claworks-main.json
 */
import { execSync } from "node:child_process";
import { parseArgs } from "node:util";
import {
  buildBranchProtectionApiPath,
  DEFAULT_PROTECTION_PATH,
  formatProtectionPlan,
  loadBranchProtectionConfig,
} from "./lib/claworks-apply-branch-protection.mjs";

const { values } = parseArgs({
  options: {
    apply: { type: "boolean", default: false },
    "list-checks": { type: "boolean", default: false },
    branch: { type: "string", default: "main" },
    repo: { type: "string" },
    config: { type: "string", default: DEFAULT_PROTECTION_PATH },
    help: { type: "boolean", short: "h" },
  },
});

if (values.help) {
  console.log(`Usage: node scripts/claworks-apply-branch-protection.mjs [--apply] [--list-checks]

  --apply          PUT branch protection via \`gh api\` (admin required)
  --list-checks    List recent check-run names on the branch HEAD
  --branch main    Target branch (default: main)
  --repo o/r       Override owner/repo (default: gh repo view)
  --config PATH    Protection JSON (default: .github/branch-protection/claworks-main.json)
`);
  process.exit(0);
}

function resolveRepo() {
  if (values.repo?.trim()) {
    const [owner, repo] = values.repo.trim().split("/");
    if (!owner || !repo) {
      throw new Error("--repo must be owner/name");
    }
    return { owner, repo };
  }
  const json = execSync("gh repo view --json nameWithOwner", { encoding: "utf8" });
  const nameWithOwner = JSON.parse(json).nameWithOwner;
  const [owner, repo] = nameWithOwner.split("/");
  return { owner, repo };
}

function ghApiPut(path, body) {
  execSync(`gh api -X PUT ${path} --input -`, {
    input: JSON.stringify(body),
    stdio: ["pipe", "inherit", "inherit"],
  });
}

function listChecks({ owner, repo, branch }) {
  const sha = execSync(`gh api repos/${owner}/${repo}/git/ref/heads/${branch} --jq .object.sha`, {
    encoding: "utf8",
  }).trim();
  const out = execSync(
    `gh api repos/${owner}/${repo}/commits/${sha}/check-runs --jq '.check_runs[] | .name'`,
    { encoding: "utf8" },
  ).trim();
  console.log(`Recent check runs on ${owner}/${repo}@${branch} (${sha.slice(0, 7)}):`);
  if (!out) {
    console.log("  (none — run ClaWorks workflows on a PR first)");
    return;
  }
  for (const line of out.split("\n")) {
    console.log(`  - ${line}`);
  }
}

const branch = values.branch?.trim() || "main";
const config = loadBranchProtectionConfig(values.config);
const { owner, repo } = resolveRepo();

if (values["list-checks"]) {
  listChecks({ owner, repo, branch });
  process.exit(0);
}

console.log("[claworks:branch-protection] plan\n");
console.log(formatProtectionPlan({ owner, repo, branch, config }));
console.log(`\nAPI: PUT ${buildBranchProtectionApiPath({ owner, repo, branch })}`);

if (!values.apply) {
  console.log(
    "\n[dry-run] No changes applied. Run with --apply after verifying check names (--list-checks).",
  );
  console.log("Docs: docs/GITHUB-BRANCH-PROTECTION.md");
  process.exit(0);
}

console.log("\n[claworks:branch-protection] applying…");
try {
  ghApiPut(buildBranchProtectionApiPath({ owner, repo, branch }), config);
  console.log("[claworks:branch-protection] applied successfully");
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`[claworks:branch-protection] FAIL: ${msg}`);
  console.error(
    "Common blockers: missing admin on repo, check names mismatch, or org policy forbids classic protection.",
  );
  process.exit(1);
}
