#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { isDirectRunUrl } from "./lib/direct-run.mjs";
import { execPlainGh } from "./lib/plain-gh.mjs";

export const SCHEDULED_HOSTED_WORKFLOWS = [
  "Blacksmith Testbox",
  "Blacksmith ARM Testbox",
  "Blacksmith Build Artifacts Testbox",
  "Workflow Sanity",
];
const CI_WORKFLOW_PATH = ".github/workflows/ci.yml";
const BUILD_ARTIFACTS_WORKFLOW = "Blacksmith Build Artifacts Testbox";
const ARTIFACT_FALLBACK_REQUIRED_WORKFLOWS = [
  "Blacksmith Testbox",
  "Blacksmith ARM Testbox",
  "Workflow Sanity",
];
const WORKFLOW_RUNS_PAGE_SIZE = 100;
const MAX_WORKFLOW_RUN_SEARCH_RESULTS = 1_000;

function readOptionValue(argv, index, optionName) {
  const value = argv[index + 1];
  if (!value || value.startsWith("-")) {
    throw new Error(`Expected ${optionName} <value>.`);
  }
  return value;
}

export function parseArgs(argv) {
  const args = { repo: "", sha: "", output: "", changelogOnly: false };
  const seen = new Set();
  const setOnce = (flag, key, value) => {
    if (seen.has(flag)) {
      throw new Error(`${flag} was provided more than once.`);
    }
    seen.add(flag);
    args[key] = value;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--repo":
        setOnce(arg, "repo", readOptionValue(argv, index, arg));
        index += 1;
        break;
      case "--sha":
        setOnce(arg, "sha", readOptionValue(argv, index, arg));
        index += 1;
        break;
      case "--output":
        setOnce(arg, "output", readOptionValue(argv, index, arg));
        index += 1;
        break;
      case "--changelog-only":
        setOnce(arg, "changelogOnly", true);
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
    run?.event === "workflow_dispatch" &&
    run?.head_sha === sha &&
    String(run?.path ?? "").split("@", 1)[0] === CI_WORKFLOW_PATH &&
    run?.display_title === `CI release gate ${sha}`
  );
}

function matchingAuthoritativeRuns(runs, workflowName, sha) {
  return runs.filter((run) => {
    if (run?.head_sha !== sha) {
      return false;
    }
    if (run?.event === "pull_request") {
      return run.name === workflowName;
    }
    return workflowName === "CI" && isReleaseGateCiRun(run, sha);
  });
}

function latestRun(runs) {
  return runs.toSorted((left, right) =>
    String(right.updated_at ?? "").localeCompare(String(left.updated_at ?? "")),
  )[0];
}

function preferredCiRun(runs) {
  const scheduledRuns = runs.filter((run) => run.event === "pull_request");
  const latestScheduledRun = latestRun(scheduledRuns);
  const failedScheduledRun = latestRun(
    scheduledRuns.filter(
      (run) =>
        run.status === "completed" && !["success", "cancelled", "skipped"].includes(run.conclusion),
    ),
  );
  if (failedScheduledRun && latestScheduledRun?.status !== "completed") {
    return failedScheduledRun;
  }
  if (latestScheduledRun?.status === "completed") {
    return latestScheduledRun;
  }
  return latestRun(runs.filter((run) => run.event === "workflow_dispatch")) ?? latestScheduledRun;
}

function successfulRunOrThrow(runs, workflowName, sha) {
  const matchingRuns = matchingAuthoritativeRuns(runs, workflowName, sha);
  const run = workflowName === "CI" ? preferredCiRun(matchingRuns) : latestRun(matchingRuns);
  if (!run || run.status !== "completed" || run.conclusion !== "success") {
    throw new Error(
      `Missing successful exact-head ${workflowName} workflow for ${sha}. Observed: ${formatObservedRuns(matchingRuns)}`,
    );
  }
  return run;
}

function successfulReleaseGateFallback(workflowRuns, sha) {
  const fallback = latestRun(workflowRuns.filter((run) => isReleaseGateCiRun(run, sha)));
  if (fallback?.status !== "completed" || fallback.conclusion !== "success") {
    return null;
  }
  return fallback;
}

function canCoverQueuedBuildArtifacts(workflowRuns, sha) {
  if (!successfulReleaseGateFallback(workflowRuns, sha)) {
    return false;
  }
  const supportingGatesPassed = ARTIFACT_FALLBACK_REQUIRED_WORKFLOWS.every((workflowName) => {
    const run = latestRun(matchingAuthoritativeRuns(workflowRuns, workflowName, sha));
    return run?.status === "completed" && run.conclusion === "success";
  });
  if (!supportingGatesPassed) {
    return false;
  }
  const buildArtifactRuns = matchingAuthoritativeRuns(workflowRuns, BUILD_ARTIFACTS_WORKFLOW, sha);
  const latestBuildArtifactRun = latestRun(buildArtifactRuns);
  return (
    latestBuildArtifactRun?.status === "queued" &&
    buildArtifactRuns.every(
      (run) =>
        run.status === "queued" || (run.status === "completed" && run.conclusion === "success"),
    )
  );
}

function stripAnsi(raw) {
  const escape = String.fromCharCode(27);
  return raw.replace(new RegExp(`${escape}\\[[0-?]*[ -/]*[@-~]`, "gu"), "");
}

export function parseWorkflowRunPage(raw) {
  const page = JSON.parse(stripAnsi(raw));
  return {
    totalCount: page.total_count ?? 0,
    workflowRuns: page.workflow_runs ?? [],
  };
}

export function workflowRunPageCount(totalCount) {
  return Math.min(
    Math.ceil(totalCount / WORKFLOW_RUNS_PAGE_SIZE),
    MAX_WORKFLOW_RUN_SEARCH_RESULTS / WORKFLOW_RUNS_PAGE_SIZE,
  );
}

export function collectHostedGateEvidence({ sha, workflowRuns, changelogOnly = false }) {
  if (!Array.isArray(workflowRuns)) {
    throw new Error("workflowRuns must be an array.");
  }
  const workflows = [];
  const fallbackCoveredWorkflows = [];
  let ciRun;
  if (!changelogOnly) {
    ciRun = successfulRunOrThrow(workflowRuns, "CI", sha);
    workflows.push(ciRun);
  }
  for (const workflowName of SCHEDULED_HOSTED_WORKFLOWS) {
    const matchingRuns = matchingAuthoritativeRuns(workflowRuns, workflowName, sha);
    if (matchingRuns.length > 0) {
      if (
        workflowName === BUILD_ARTIFACTS_WORKFLOW &&
        canCoverQueuedBuildArtifacts(workflowRuns, sha)
      ) {
        fallbackCoveredWorkflows.push({
          name: workflowName,
          coveredBy: "CI release gate",
          reason: "scheduled workflow is queued",
        });
        continue;
      }
      workflows.push(successfulRunOrThrow(workflowRuns, workflowName, sha));
    }
  }
  const evidence = {
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
  if (fallbackCoveredWorkflows.length > 0) {
    evidence.fallbackCoveredWorkflows = fallbackCoveredWorkflows;
  }
  return evidence;
}

function loadWorkflowRuns(repo, sha) {
  const loadPage = (page) =>
    parseWorkflowRunPage(
      execPlainGh(
        [
          "api",
          `repos/${repo}/actions/runs?head_sha=${sha}&per_page=${WORKFLOW_RUNS_PAGE_SIZE}&page=${page}`,
        ],
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      ),
    );

  // Keep every request pinned to the head SHA and bound it to GitHub's documented search window.
  const firstPage = loadPage(1);
  const workflowRuns = [...firstPage.workflowRuns];
  for (let page = 2; page <= workflowRunPageCount(firstPage.totalCount); page += 1) {
    workflowRuns.push(...loadPage(page).workflowRuns);
  }
  return workflowRuns;
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
