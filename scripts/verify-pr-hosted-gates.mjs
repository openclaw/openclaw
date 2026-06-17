#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { isDirectRunUrl } from "./lib/direct-run.mjs";

export const SCHEDULED_HOSTED_WORKFLOWS = [
  "Blacksmith Testbox",
  "Blacksmith ARM Testbox",
  "Blacksmith Build Artifacts Testbox",
  "Workflow Sanity",
];

function readOptionValue(argv, index, optionName) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`Expected ${optionName} <value>.`);
  }
  return value;
}

export function parseArgs(argv) {
  const args = { repo: "", sha: "", output: "", changelogOnly: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--repo":
        args.repo = readOptionValue(argv, index, arg);
        index += 1;
        break;
      case "--sha":
        args.sha = readOptionValue(argv, index, arg);
        index += 1;
        break;
      case "--output":
        args.output = readOptionValue(argv, index, arg);
        index += 1;
        break;
      case "--changelog-only":
        args.changelogOnly = true;
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }
  if (!args.repo || !args.sha || !args.output) {
    throw new Error(
      "Usage: node scripts/verify-pr-hosted-gates.mjs --repo <owner/repo> --sha <sha> --output <path>",
    );
  }
  return args;
}

function formatObservedRuns(runs) {
  if (runs.length === 0) {
    return "none";
  }
  return runs
    .map(
      (run) => `${run.id ?? "unknown"}:${run.status ?? "unknown"}/${run.conclusion ?? "unknown"}`,
    )
    .join(", ");
}

function isReleaseGateCiRun(run, sha) {
  return (
    run?.name === "CI" &&
    run?.event === "workflow_dispatch" &&
    run?.head_sha === sha &&
    run?.display_title === `CI release gate ${sha}`
  );
}

function matchingAuthoritativeRuns(runs, workflowName, sha) {
  return runs.filter((run) => {
    if (run?.name !== workflowName || run?.head_sha !== sha) {
      return false;
    }
    return run.event === "pull_request" || (workflowName === "CI" && isReleaseGateCiRun(run, sha));
  });
}

function latestRun(runs) {
  return runs.toSorted((left, right) =>
    String(right.updated_at ?? "").localeCompare(String(left.updated_at ?? "")),
  )[0];
}

function successfulRunOrThrow(runs, workflowName, sha) {
  const matchingRuns = matchingAuthoritativeRuns(runs, workflowName, sha);
  const run = latestRun(matchingRuns);
  if (!run || run.status !== "completed" || run.conclusion !== "success") {
    throw new Error(
      `Missing successful exact-head ${workflowName} workflow for ${sha}. Observed: ${formatObservedRuns(matchingRuns)}`,
    );
  }
  return run;
}

function stripAnsi(raw) {
  const escape = String.fromCharCode(27);
  return raw.replace(new RegExp(`${escape}\\[[0-?]*[ -/]*[@-~]`, "gu"), "");
}

export function parseWorkflowRunPages(raw) {
  return JSON.parse(stripAnsi(raw)).flatMap((page) => page.workflow_runs ?? []);
}

export function collectHostedGateEvidence({ sha, workflowRuns, changelogOnly = false }) {
  if (!Array.isArray(workflowRuns)) {
    throw new Error("workflowRuns must be an array.");
  }
  const workflows = [];
  if (!changelogOnly) {
    workflows.push(successfulRunOrThrow(workflowRuns, "CI", sha));
  }
  for (const workflowName of SCHEDULED_HOSTED_WORKFLOWS) {
    const matchingRuns = matchingAuthoritativeRuns(workflowRuns, workflowName, sha);
    if (matchingRuns.length > 0) {
      workflows.push(successfulRunOrThrow(workflowRuns, workflowName, sha));
    }
  }
  return {
    headSha: sha,
    workflows: workflows.map((run) => ({
      id: run.id,
      name: run.name,
      event: run.event,
      status: run.status,
      conclusion: run.conclusion,
      createdAt: run.created_at,
      updatedAt: run.updated_at,
      url: run.html_url,
    })),
  };
}

function loadWorkflowRuns(repo, sha) {
  const raw = execFileSync(
    "gh",
    ["api", `repos/${repo}/actions/runs?head_sha=${sha}&per_page=100`, "--paginate", "--slurp"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  return parseWorkflowRunPages(raw);
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const evidence = collectHostedGateEvidence({
    sha: args.sha,
    workflowRuns: loadWorkflowRuns(args.repo, args.sha),
    changelogOnly: args.changelogOnly,
  });
  const manifest = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    repo: args.repo,
    ...evidence,
  };
  mkdirSync(path.dirname(args.output), { recursive: true });
  writeFileSync(args.output, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(
    `Exact-head hosted gates passed for ${args.sha}: ${manifest.workflows
      .map((workflow) => `${workflow.name}#${workflow.id}`)
      .join(", ")}`,
  );
}

if (isDirectRunUrl(process.argv[1], import.meta.url)) {
  main();
}
