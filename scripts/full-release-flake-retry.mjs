#!/usr/bin/env node
import { execFile } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { promisify } from "node:util";
import {
  releaseFlakeIntentSha256,
  selectReleaseFlakeIntent,
  validateReleaseFlakeIntent,
  validateReleaseFlakeRecords,
} from "./full-release-flake-policy.mjs";
import {
  classifyReleaseGhTransportError,
  composeReleaseChildAttemptEvidence,
  serializeReleaseArtifact,
  validateReleaseChildRunProvenance,
  validateReleaseExecutionPlanArtifact,
} from "./full-release-validation-policy.mjs";

const exec = promisify(execFile);
const POLL_MS = 30_000;
const MAX_OWNER_BUDGET_MS = 330 * 60_000;
const sleep = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
const read = (path) => JSON.parse(readFileSync(path, "utf8"));
function write(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, serializeReleaseArtifact(value));
}
function output(key, value) {
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
  }
}

function githubClient(repository, deadline) {
  async function gh(args) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new Error("automatic retry owner deadline expired");
    }
    const { stdout } = await exec("gh", args, {
      encoding: "utf8",
      timeout: Math.min(60_000, remaining),
      maxBuffer: 8 * 1024 * 1024,
    });
    return stdout;
  }
  const route = (path) => `repos/${repository}/${path}`;
  const json = async (path) =>
    JSON.parse(await gh(["api", "-H", "Cache-Control: max-age=0", route(path)]));
  return {
    getRun: (runId) => json(`actions/runs/${runId}`),
    getAttempt: (runId, attempt) => json(`actions/runs/${runId}/attempts/${attempt}`),
    getJobs: async (runId, attempt) =>
      (
        await gh([
          "api",
          "--paginate",
          "-H",
          "Cache-Control: max-age=0",
          route(`actions/runs/${runId}/attempts/${attempt}/jobs?per_page=100`),
          "--jq",
          ".jobs[] | @json",
        ])
      )
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
    getLog: (jobId) => gh(["api", route(`actions/jobs/${jobId}/logs`)]),
    rerun: (intent) =>
      gh([
        "api",
        "--method",
        "POST",
        route(
          intent.mode === "job"
            ? `actions/jobs/${intent.jobs[0].id}/rerun`
            : `actions/runs/${intent.runId}/rerun-failed-jobs`,
        ),
      ]),
  };
}

function parentBinding(run, plan, attempt) {
  if (
    String(run.id) !== plan.parentRunId ||
    run.repository?.full_name !== plan.repository ||
    run.head_sha !== plan.workflowSha ||
    run.head_branch !== plan.workflowRef ||
    run.path?.split("@", 1)[0] !== ".github/workflows/full-release-validation.yml" ||
    run.event !== "workflow_dispatch" ||
    run.run_attempt !== attempt
  ) {
    throw Object.assign(new Error("automatic retry parent provenance changed"), {
      code: "FRV_PARENT_PROVENANCE",
    });
  }
}
const childExpected = (plan, child) => ({
  ...child,
  plannedRunAttempt: child.runAttempt,
  repository: plan.repository,
});

async function originalRetryOwner(plan, childKey, client) {
  parentBinding(await client.getAttempt(plan.parentRunId, 1), plan, 1);
  const jobs = await client.getJobs(plan.parentRunId, 1);
  const owners = jobs.filter((job) => job.name === `Automatic retry (${childKey})`);
  if (owners.length !== 1 || !Array.isArray(owners[0].steps)) {
    throw new Error("automatic retry original owner is missing or duplicated");
  }
  return owners[0];
}

function provesNoRetryClaim(owner) {
  return [
    "Upload automatic retry intent",
    "Record automatic retry intent digest",
    "Execute automatic retry",
  ].every((name) => {
    const steps = owner.steps.filter((step) => step.name === name);
    return (
      steps.length === 1 && steps[0].status === "completed" && steps[0].conclusion === "skipped"
    );
  });
}

async function retainedJobRows(client, run) {
  const jobs = [];
  for (let attempt = 1; attempt <= run.run_attempt; attempt += 1) {
    jobs.push(...(await client.getJobs(String(run.id), attempt)));
  }
  return jobs;
}

async function verifyNoRetryClaim(plan, childKey, client) {
  if (!provesNoRetryClaim(await originalRetryOwner(plan, childKey, client))) {
    throw new Error("automatic retry receipt omits its original intent");
  }
  const child = plan.children.find((entry) => entry.key === childKey);
  const run = await client.getRun(child.runId);
  validateReleaseChildRunProvenance(run, childExpected(plan, child));
  selectReleaseFlakeIntent(plan, child, run, await retainedJobRows(client, run));
}

async function authenticateIntent(intent, plan, client) {
  validateReleaseFlakeIntent(intent, plan);
  const owner = await originalRetryOwner(plan, intent.child, client);
  const witness = owner?.steps?.find(
    (step) => step.name === "Record automatic retry intent digest",
  );
  const upload = owner?.steps?.find((step) => step.name === "Upload automatic retry intent");
  if (
    witness?.conclusion !== "success" ||
    upload?.conclusion !== "success" ||
    witness.number <= upload.number ||
    !Number.isFinite(Date.parse(witness.started_at)) ||
    !Number.isFinite(Date.parse(witness.completed_at)) ||
    Date.parse(witness.started_at) < Date.parse(upload.completed_at)
  ) {
    throw new Error("automatic retry original intent witness is missing");
  }
  const log = await client.getLog(owner.id);
  const matches = [
    ...log.matchAll(/^(\d{4}-\d\d-\d\dT\S+Z) FRV_AUTO_RETRY_INTENT_SHA256=([a-f0-9]{64})\r?$/gmu),
  ].filter(
    (match) =>
      Date.parse(match[1]) >= Date.parse(witness.started_at) &&
      Date.parse(match[1]) < Date.parse(witness.completed_at) + 1000,
  );
  if (matches.length !== 1 || matches[0][2] !== releaseFlakeIntentSha256(intent)) {
    throw new Error("automatic retry cached intent differs from its original upload witness");
  }
  return { owner, log };
}

export async function prepareReleaseFlakeRetry({
  plan,
  childKey,
  parentAttempt,
  ownerDeadlineMs,
  client,
  wait = sleep,
  now = Date.now,
}) {
  const child = plan.children.find((entry) => entry.key === childKey && entry.selected);
  if (!child) {
    throw new Error("automatic retry child is not selected");
  }
  if (parentAttempt !== 1) {
    return null;
  }
  const deadline = ownerDeadlineMs;
  while (now() < deadline) {
    const run = await client.getRun(child.runId);
    validateReleaseChildRunProvenance(run, childExpected(plan, child));
    if (run.status === "completed") {
      const jobs = await retainedJobRows(client, run);
      // The immutable first attempt is the only automatic wave. Later attempts
      // consume the allowance regardless of who requested the previous rerun.
      if (run.run_attempt !== 1 || child.runAttempt !== 1) {
        return selectReleaseFlakeIntent(plan, child, run, jobs);
      }
      composeReleaseChildAttemptEvidence({
        attempts: [{ runAttempt: 1, jobs }],
        expected: childExpected(plan, child),
        run,
      });
      return selectReleaseFlakeIntent(plan, child, run, jobs);
    }
    await wait(POLL_MS);
  }
  throw new Error("automatic retry owner deadline expired while waiting for its child");
}

export async function executeReleaseFlakeRetry({
  plan,
  intent,
  parentAttempt,
  ownerDeadlineMs,
  client,
  record,
  wait = sleep,
  now = Date.now,
}) {
  validateReleaseFlakeIntent(intent, plan);
  const child = plan.children.find((entry) => entry.key === intent.child);
  const expected = childExpected(plan, child);
  const deadline =
    parentAttempt === 1 ? ownerDeadlineMs : Math.min(ownerDeadlineMs, now() + 10 * 60_000);
  let outcome = {
    child: intent.child,
    executionPlanSha256: plan.sha256,
    intent,
    outcome: "unknown",
    replacements: [],
  };
  if (parentAttempt === 1) {
    try {
      if (!(now() < ownerDeadlineMs)) {
        throw new Error("automatic retry owner deadline expired before mutation");
      }
      const before = await client.getRun(intent.runId);
      validateReleaseChildRunProvenance(before, expected);
      const jobs = await client.getJobs(intent.runId, 1);
      if (
        before.status !== "completed" ||
        before.run_attempt !== 1 ||
        JSON.stringify(selectReleaseFlakeIntent(plan, child, before, jobs)) !==
          JSON.stringify(intent)
      ) {
        throw new Error("automatic retry source job changed after the intent claim");
      }
      // Revalidate child eligibility, then current parent authority before the
      // one-shot POST; neither immutable identity nor a stale status grants it.
      const latest = await client.getRun(intent.runId);
      validateReleaseChildRunProvenance(latest, expected);
      if (latest.run_attempt !== 1 || latest.status !== "completed") {
        throw new Error("automatic retry child advanced before mutation");
      }
      const parent = await client.getRun(plan.parentRunId);
      parentBinding(parent, plan, 1);
      if (parent.status !== "in_progress") {
        throw new Error("automatic retry parent is no longer active");
      }
      if (!(now() < ownerDeadlineMs)) {
        throw new Error("automatic retry owner deadline expired before mutation");
      }
    } catch (error) {
      record({ ...outcome, outcome: "rejected" });
      throw error;
    }
    record(outcome);
    try {
      await client.rerun(intent);
    } catch (error) {
      if (classifyReleaseGhTransportError(error) === "hard") {
        outcome = { ...outcome, outcome: "rejected" };
        record(outcome);
        throw error;
      }
      // A lost response may already have queued the rerun. Only reads follow.
    }
  } else {
    const rejectedIntent = await authenticatedOriginalRejection(plan, intent.child, client);
    if (now() >= deadline) {
      throw new Error("automatic retry reconciliation deadline expired");
    }
    if (rejectedIntent) {
      if (releaseFlakeIntentSha256(rejectedIntent) !== releaseFlakeIntentSha256(intent)) {
        throw new Error("automatic retry rejection differs from its original intent");
      }
      outcome = { ...outcome, outcome: "rejected" };
      record(outcome);
      return outcome;
    }
    record(outcome);
  }
  let sourceJobs;
  while (now() < deadline) {
    let materializing = false;
    try {
      const current = await client.getRun(intent.runId);
      validateReleaseChildRunProvenance(current, expected);
      if (current.run_attempt >= 2) {
        materializing = true;
        const attempt = await client.getAttempt(intent.runId, 2);
        validateReleaseChildRunProvenance(attempt, expected);
        if (attempt.run_attempt !== 2) {
          throw new Error("automatic retry replacement attempt changed");
        }
        const jobs = await client.getJobs(intent.runId, 2);
        const replacements = intent.jobs.map((original) =>
          jobs.filter(
            (job) =>
              job.name === original.name &&
              !(job.status === "completed" && job.conclusion === "skipped"),
          ),
        );
        if (
          replacements.every(
            (matches, index) =>
              matches.length === 1 &&
              String(matches[0].id) !== intent.jobs[index].id &&
              (matches[0].run_attempt === undefined || matches[0].run_attempt === 2) &&
              (matches[0].run_id === undefined || String(matches[0].run_id) === intent.runId),
          )
        ) {
          outcome = {
            ...outcome,
            outcome: "observed",
            replacements: replacements.map(([job]) => ({
              id: String(job.id),
              name: job.name,
              runAttempt: 2,
            })),
          };
          validateReleaseFlakeRecords([outcome], plan);
          record(outcome);
          if (attempt.status === "completed" && jobs.every((job) => job.status === "completed")) {
            sourceJobs ??= await client.getJobs(intent.runId, 1);
            composeReleaseChildAttemptEvidence({
              attempts: [
                { runAttempt: 1, jobs: sourceJobs },
                { runAttempt: 2, jobs },
              ],
              expected,
              run: attempt,
            });
            return outcome;
          }
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (
        classifyReleaseGhTransportError(error) !== "transient" &&
        !(
          materializing &&
          (/HTTP 404/u.test(message) ||
            message.startsWith("release child attempt 2 contains duplicate job identity:"))
        )
      ) {
        throw error;
      }
    }
    await wait(Math.max(0, Math.min(POLL_MS, deadline - now())));
  }
  throw new Error("automatic retry attempt is unresolved; the intent must never be replayed");
}

async function originalRetrySourceIntent(plan, childKey, client) {
  const child = plan.children.find((entry) => entry.key === childKey);
  const expected = childExpected(plan, child);
  const source = await client.getAttempt(child.runId, 1);
  const sourceJobs = await client.getJobs(child.runId, 1);
  validateReleaseChildRunProvenance(source, expected);
  composeReleaseChildAttemptEvidence({
    attempts: [{ runAttempt: 1, jobs: sourceJobs }],
    expected,
    run: source,
  });
  if (source.run_attempt !== 1 || source.status !== "completed") {
    throw new Error("automatic retry source job receipt differs from exact attempt one");
  }
  return selectReleaseFlakeIntent(plan, child, source, sourceJobs);
}

async function authenticateRetrySource(intent, plan, client) {
  if (
    JSON.stringify(await originalRetrySourceIntent(plan, intent.child, client)) !==
    JSON.stringify(intent)
  ) {
    throw new Error("automatic retry source job receipt differs from exact attempt one");
  }
}

export async function verifyReleaseFlakeRetryRecords(plan, records, client) {
  validateReleaseFlakeRecords(records, plan);
  for (const record of records) {
    if (record.intent === null) {
      await verifyNoRetryClaim(plan, record.child, client);
      continue;
    }
    const { intent } = record;
    if (record.outcome === "rejected") {
      const rejectedIntent = await authenticatedOriginalRejection(plan, record.child, client);
      if (
        !rejectedIntent ||
        releaseFlakeIntentSha256(rejectedIntent) !== releaseFlakeIntentSha256(intent)
      ) {
        throw new Error("automatic retry rejection differs from its original witness");
      }
      continue;
    }
    await authenticateIntent(intent, plan, client);
    await authenticateRetrySource(intent, plan, client);
    const child = plan.children.find((entry) => entry.key === intent.child);
    const expected = childExpected(plan, child);
    if (record.outcome !== "observed") {
      throw new Error("automatic retry outcome is unresolved");
    }
    const replacement = await client.getAttempt(intent.runId, 2);
    const replacementJobs = await client.getJobs(intent.runId, 2);
    validateReleaseChildRunProvenance(replacement, expected);
    if (
      replacement.run_attempt !== 2 ||
      record.replacements.some((job) => {
        const matches = replacementJobs.filter(
          (observed) =>
            observed.name === job.name &&
            !(observed.status === "completed" && observed.conclusion === "skipped"),
        );
        return (
          matches.length !== 1 ||
          String(matches[0].id) !== job.id ||
          (matches[0].run_attempt !== undefined && matches[0].run_attempt !== 2)
        );
      })
    ) {
      throw new Error("automatic retry replacement receipt differs from exact attempt two");
    }
  }
}

async function authenticatedOriginalRejection(plan, childKey, client) {
  const intent = await originalRetrySourceIntent(plan, childKey, client);
  if (!intent) {
    return null;
  }
  const { owner, log } = await authenticateIntent(intent, plan, client);
  const witnesses = owner.steps.filter(
    (step) => step.name === "Record automatic retry rejection digest",
  );
  const executions = owner.steps.filter((step) => step.name === "Execute automatic retry");
  const witness = witnesses[0];
  const execution = executions[0];
  if (
    owner.status !== "completed" ||
    witnesses.length !== 1 ||
    witness.status !== "completed" ||
    witness.conclusion !== "success"
  ) {
    return null;
  }
  const matches = [
    ...log.matchAll(
      /^(\d{4}-\d\d-\d\dT\S+Z) FRV_AUTO_RETRY_REJECTED_INTENT_SHA256=([a-f0-9]{64})\r?$/gmu,
    ),
  ].filter(
    (match) =>
      Date.parse(match[1]) >= Date.parse(witness.started_at) &&
      Date.parse(match[1]) < Date.parse(witness.completed_at) + 1000,
  );
  if (matches.length === 0) {
    return null;
  }
  if (
    executions.length !== 1 ||
    execution.status !== "completed" ||
    execution.conclusion !== "failure" ||
    !Number.isSafeInteger(execution.number) ||
    !Number.isSafeInteger(witness.number) ||
    witness.number <= execution.number ||
    !Number.isFinite(Date.parse(execution.completed_at)) ||
    !Number.isFinite(Date.parse(witness.started_at)) ||
    !Number.isFinite(Date.parse(witness.completed_at)) ||
    Date.parse(witness.completed_at) < Date.parse(witness.started_at) ||
    Date.parse(witness.started_at) < Date.parse(execution.completed_at) ||
    matches.length !== 1 ||
    matches[0][2] !== releaseFlakeIntentSha256(intent)
  ) {
    throw new Error("automatic retry rejection is not bound to its original owner witness");
  }
  return intent;
}

// Historical owner disposition never replaces the caller's final live run checks.
export async function verifyReleaseFlakeManualRetryAuthority({ plan, childKey, client }) {
  if (!plan.knownFlakyJobs?.some((selector) => selector.startsWith(`${childKey}:`))) {
    throw new Error("manual retry child has no declared automatic owner");
  }
  const owner = await originalRetryOwner(plan, childKey, client);
  if (owner.status !== "completed") {
    throw new Error("automatic retry owner is still active");
  }
  if (provesNoRetryClaim(owner)) {
    await verifyNoRetryClaim(plan, childKey, client);
    return { outcome: "not-attempted" };
  }
  if (!(await authenticatedOriginalRejection(plan, childKey, client))) {
    throw new Error(
      `automatic retry outcome is unresolved for ${childKey}: rejection witness is missing`,
    );
  }
  return { outcome: "rejected" };
}

async function main() {
  const plan = validateReleaseExecutionPlanArtifact(
    read(process.env.FULL_RELEASE_EXECUTION_PLAN_PATH),
    {
      parentRunId: process.env.GITHUB_RUN_ID,
      repository: process.env.GITHUB_REPOSITORY,
      workflowSha: process.env.GITHUB_SHA,
      workflowRef: process.env.GITHUB_REF_NAME,
    },
  );
  const parentAttempt = Number(process.env.GITHUB_RUN_ATTEMPT);
  const ownerDeadlineMs = Number(process.env.FULL_RELEASE_RETRY_DEADLINE_MS);
  if (
    !Number.isSafeInteger(ownerDeadlineMs) ||
    ownerDeadlineMs > Date.now() + MAX_OWNER_BUDGET_MS
  ) {
    throw new Error("automatic retry owner requires its bounded shared deadline");
  }
  const client = githubClient(
    plan.repository,
    parentAttempt === 1 ? ownerDeadlineMs : Math.min(ownerDeadlineMs, Date.now() + 10 * 60_000),
  );
  const intentPath = process.env.FULL_RELEASE_RETRY_INTENT_PATH;
  if (process.argv[2] === "prepare") {
    const noRetry = () =>
      write(process.env.FULL_RELEASE_RETRY_RECORD_PATH, {
        child: process.env.FULL_RELEASE_RETRY_CHILD,
        executionPlanSha256: plan.sha256,
        intent: null,
        outcome: "not-attempted",
        replacements: [],
      });
    if (parentAttempt > 1) {
      if (existsSync(intentPath)) {
        await authenticateIntent(read(intentPath), plan, client);
        output("restored", "true");
      } else {
        await verifyNoRetryClaim(plan, process.env.FULL_RELEASE_RETRY_CHILD, client);
      }
      if (!existsSync(intentPath)) {
        noRetry();
      }
      return;
    }
    if (existsSync(intentPath)) {
      throw new Error("automatic retry intent already exists; never replay a claim");
    }
    const intent = await prepareReleaseFlakeRetry({
      plan,
      childKey: process.env.FULL_RELEASE_RETRY_CHILD,
      parentAttempt,
      ownerDeadlineMs,
      client,
    });
    if (intent) {
      write(intentPath, intent);
      output("prepared", "true");
      output("sha256", releaseFlakeIntentSha256(intent));
    } else {
      noRetry();
    }
  } else if (process.argv[2] === "execute") {
    const intent = read(intentPath);
    await executeReleaseFlakeRetry({
      plan,
      intent,
      parentAttempt,
      ownerDeadlineMs,
      client,
      record: (value) => write(process.env.FULL_RELEASE_RETRY_RECORD_PATH, value),
    });
  } else if (process.argv[2] === "witness") {
    if (parentAttempt !== 1) {
      throw new Error("automatic rejection witness belongs only to the original parent attempt");
    }
    const record = validateReleaseFlakeRecords(
      [read(process.env.FULL_RELEASE_RETRY_RECORD_PATH)],
      plan,
    )[0];
    if (record.outcome === "rejected") {
      console.log(
        `FRV_AUTO_RETRY_REJECTED_INTENT_SHA256=${releaseFlakeIntentSha256(record.intent)}`,
      );
    }
  } else {
    throw new Error("usage: full-release-flake-retry.mjs <prepare|execute|witness>");
  }
}
if (process.argv[1]?.endsWith("full-release-flake-retry.mjs")) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
