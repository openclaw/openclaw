#!/usr/bin/env node
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import process from "node:process";
import {
  composeReleaseChildAttemptEvidence,
  releaseChildSpec,
  releaseCompositeJobsSha256,
  validateReleaseChildRunProvenance,
} from "./full-release-validation-policy.mjs";
import { canonicalizeJsonValue } from "./lib/canonical-json.mjs";
import {
  FULL_RELEASE_CHILD_EVIDENCE_JOB as PUBLISHER_JOB,
  serializeReleaseArtifact,
} from "./lib/full-release-evidence.mjs";
import { execGhRead } from "./lib/plain-gh.mjs";

const MAX_INPUT_BYTES = 128 * 1024;

function required(name, pattern) {
  const value = process.env[name] ?? "";
  if (!pattern.test(value)) {
    throw new Error(`Invalid ${name}`);
  }
  return value;
}

function readJson(path, maxBytes) {
  if (statSync(path).size > maxBytes) {
    throw new Error("Child evidence input exceeds its byte limit");
  }
  return JSON.parse(readFileSync(path, "utf8"));
}

function github(repository, endpoint, paginate = false) {
  const args = ["api", `repos/${repository}/${endpoint}`];
  if (paginate) {
    args.push("--paginate", "--slurp");
  }
  return JSON.parse(
    execGhRead(args, {
      encoding: "utf8",
      timeout: 60_000,
      maxBuffer: 4 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    }),
  );
}

function readJobs(repository, runId, runAttempt) {
  const pages = github(
    repository,
    `actions/runs/${runId}/attempts/${runAttempt}/jobs?per_page=100`,
    true,
  );
  if (!Array.isArray(pages) || pages.length === 0 || pages.length > 20) {
    throw new Error("Child evidence job inventory is incomplete");
  }
  const jobs = pages.flatMap((page) => {
    if (!Array.isArray(page.jobs) || page.total_count !== pages[0].total_count) {
      throw new Error("Child evidence job inventory is incomplete");
    }
    return page.jobs;
  });
  if (
    jobs.length !== pages[0].total_count ||
    jobs.some((job) => String(job.run_id) !== runId || job.run_attempt !== runAttempt)
  ) {
    throw new Error("Child evidence job inventory is incomplete or belongs to another attempt");
  }
  return jobs;
}

function seal() {
  const repository = required("GITHUB_REPOSITORY", /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u);
  const runId = required("GITHUB_RUN_ID", /^[1-9][0-9]*$/u);
  const runAttempt = Number(required("GITHUB_RUN_ATTEMPT", /^[1-9][0-9]*$/u));
  const workflowSha = required("GITHUB_SHA", /^[a-f0-9]{40}$/u);
  const targetSha = required("FRV_CHILD_TARGET_SHA", /^[a-f0-9]{40}$/u);
  const role = required("FRV_CHILD_ROLE", /^[A-Za-z]+$/u);
  const spec = releaseChildSpec(role);
  const event = readJson(required("GITHUB_EVENT_PATH", /\S/u), MAX_INPUT_BYTES);
  const inputs = event.inputs;
  if (
    !inputs ||
    typeof inputs !== "object" ||
    Array.isArray(inputs) ||
    Object.values(inputs).some((value) => !["string", "boolean", "number"].includes(typeof value))
  ) {
    throw new Error("Child evidence requires scalar workflow dispatch inputs");
  }
  const dispatchId = String(inputs.dispatch_id ?? "");
  const parent = /^full-release-validation-([1-9][0-9]*)-([1-9][0-9]*)(.*)$/u.exec(dispatchId);
  if (!parent || parent[3] !== spec.suffix) {
    throw new Error("Child evidence dispatch does not match its release role");
  }
  if (!Number.isSafeInteger(runAttempt) || runAttempt > 32) {
    throw new Error("Child evidence attempt inventory exceeds its bound");
  }
  const run = github(repository, `actions/runs/${runId}`);
  const expected = {
    key: role,
    repository,
    runId,
    plannedRunAttempt: 1,
    displayTitle: `${spec.displayName} ${dispatchId}`,
    workflow: spec.workflow,
    workflowRef: required("GITHUB_REF_NAME", /\S/u),
    workflowSha,
  };
  validateReleaseChildRunProvenance(run, expected);
  if (
    run.run_attempt !== runAttempt ||
    run.head_repository?.full_name !== repository ||
    run.status !== "in_progress" ||
    run.conclusion !== null
  ) {
    throw new Error("Child evidence publisher is not in the current active workflow attempt");
  }
  const lineage = github(repository, `compare/${workflowSha}...main?per_page=1`);
  if (
    !["ahead", "identical"].includes(lineage.status) ||
    lineage.merge_base_commit?.sha !== workflowSha
  ) {
    throw new Error("Child evidence workflow SHA is not a main ancestor");
  }
  const attempts = [];
  let publisher;
  for (let attempt = 1; attempt <= runAttempt; attempt += 1) {
    const allJobs = readJobs(repository, runId, attempt);
    const publishers = allJobs.filter((job) => job.name === PUBLISHER_JOB);
    if (attempt === runAttempt) {
      if (publishers.length !== 1 || publishers[0].status !== "in_progress") {
        throw new Error("Child evidence publisher job identity is ambiguous or inactive");
      }
      publisher = publishers[0];
    }
    const jobs = allJobs.filter((job) => job.name !== PUBLISHER_JOB);
    if (jobs.some((job) => job.status !== "completed")) {
      throw new Error("Child evidence cannot seal while predecessor jobs are active");
    }
    attempts.push({ runAttempt: attempt, jobs: allJobs });
  }
  const composite = composeReleaseChildAttemptEvidence({ attempts, expected, run });
  composite.jobs = composite.jobs.filter((job) => job.name !== PUBLISHER_JOB);
  composite.compositeJobsSha256 = releaseCompositeJobsSha256(composite);
  if (composite.jobs.length === 0) {
    throw new Error("Child evidence has no executed predecessor jobs");
  }
  const inputsWithoutDispatch = Object.fromEntries(
    Object.entries(inputs)
      .filter(([key]) => key !== "dispatch_id")
      .map(([key, value]) => [key, String(value)]),
  );
  // The uploader is still active. Consumers must independently require its success
  // and the completed child conclusion before accepting these predecessor facts.
  const receipt = canonicalizeJsonValue({
    schema: "openclaw.full-release-child-evidence/v1",
    repository,
    role,
    targetSha,
    workflowSha,
    workflowRef: expected.workflowRef,
    workflowPath: `.github/workflows/${spec.workflow}`,
    displayTitle: expected.displayTitle,
    dispatchId,
    sourceParentRunId: parent[1],
    sourceParentAttempt: Number(parent[2]),
    workloadConclusion: composite.jobs.every((job) =>
      ["success", "neutral"].includes(job.conclusion),
    )
      ? "success"
      : "failure",
    inputs: inputsWithoutDispatch,
    publisher: { jobId: String(publisher.id), jobName: PUBLISHER_JOB },
    ...composite,
  });
  const sha256 = createHash("sha256").update(JSON.stringify(receipt)).digest("hex");
  const output = required("FRV_CHILD_EVIDENCE_PATH", /\S/u);
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, serializeReleaseArtifact({ ...receipt, sha256 }));
  appendFileSync(
    required("GITHUB_OUTPUT", /\S/u),
    `artifact_name=full-release-child-evidence-${targetSha}-${role}-${runId}-${runAttempt}\n`,
  );
}

try {
  seal();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
