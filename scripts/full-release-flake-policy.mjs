import { createHash } from "node:crypto";
import { compareAscii } from "./lib/canonical-json.mjs";

const FAILURE = new Set(["failure", "timed_out"]);
const SUCCESS = new Set(["success", "neutral", "skipped"]);
const exactKeys = (value, keys) =>
  value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  JSON.stringify(Object.keys(value).toSorted()) === JSON.stringify(keys.toSorted());
const id = (value) => typeof value === "string" && /^[1-9][0-9]*$/u.test(value);

export function normalizeKnownFlakyJobs(value, children) {
  const selectors =
    typeof value === "string" ? JSON.parse(value) : value === undefined ? [] : value;
  if (
    !Array.isArray(selectors) ||
    selectors.length > 50 ||
    selectors.some(
      (selector) =>
        typeof selector !== "string" ||
        selector.length > 250 ||
        selector !== selector.trim() ||
        !/^[A-Za-z][A-Za-z0-9]*:.+$/u.test(selector) ||
        Array.from(selector).some(
          (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
        ) ||
        selector.slice(selector.indexOf(":") + 1).trim() !==
          selector.slice(selector.indexOf(":") + 1) ||
        (children &&
          !children.some((child) => child.selected && child.key === selector.split(":", 1)[0])),
    )
  ) {
    throw new Error(
      "known_flaky_jobs_json must contain at most 50 exact selected-child:job-name selectors",
    );
  }
  if (new Set(selectors).size !== selectors.length) {
    throw new Error("known_flaky_jobs_json contains duplicate selectors");
  }
  return selectors.toSorted(compareAscii);
}

export function releaseFlakeIntentSha256(intent) {
  return createHash("sha256").update(JSON.stringify(intent)).digest("hex");
}

export function validateReleaseFlakeIntent(intent, plan) {
  const child = plan.children.find((entry) => entry.key === intent?.child);
  if (
    !exactKeys(intent, [
      "version",
      "parentRunId",
      "executionPlanSha256",
      "child",
      "runId",
      "sourceRunAttempt",
      "expectedRunAttempt",
      "mode",
      "jobs",
    ]) ||
    intent.version !== 1 ||
    intent.parentRunId !== plan.parentRunId ||
    intent.executionPlanSha256 !== plan.sha256 ||
    !child?.selected ||
    intent.runId !== child.runId ||
    child.runAttempt !== 1 ||
    intent.sourceRunAttempt !== 1 ||
    intent.expectedRunAttempt !== 2 ||
    !["job", "failed"].includes(intent.mode) ||
    !Array.isArray(intent.jobs) ||
    intent.jobs.length < 1 ||
    intent.jobs.length > 50 ||
    (intent.mode === "job" && intent.jobs.length !== 1) ||
    (intent.mode === "failed" && intent.jobs.length < 2) ||
    intent.jobs.some(
      (job) =>
        !exactKeys(job, ["id", "name", "conclusion"]) ||
        !id(job.id) ||
        !FAILURE.has(job.conclusion) ||
        !plan.knownFlakyJobs?.includes(`${child.key}:${job.name}`),
    ) ||
    new Set(intent.jobs.map((job) => job.name)).size !== intent.jobs.length ||
    new Set(intent.jobs.map((job) => job.id)).size !== intent.jobs.length
  ) {
    throw new Error("automatic retry intent differs from the immutable execution plan");
  }
  return intent;
}

export function selectReleaseFlakeIntent(plan, child, run, jobs) {
  const selectors = normalizeKnownFlakyJobs(plan.knownFlakyJobs, plan.children).filter((selector) =>
    selector.startsWith(`${child.key}:`),
  );
  for (const selector of selectors) {
    if (!jobs.some((job) => `${child.key}:${job.name}` === selector)) {
      throw new Error(`unknown known_flaky_jobs_json job: ${selector}`);
    }
  }
  // One wave from the first attempt bounds every dependent job as well as the target.
  if (child.runAttempt !== 1 || run.run_attempt !== 1) {
    return null;
  }
  const failed = jobs.filter((job) => job.status === "completed" && !SUCCESS.has(job.conclusion));
  const eligible = failed.filter(
    (job) => FAILURE.has(job.conclusion) && selectors.includes(`${child.key}:${job.name}`),
  );
  if (eligible.length === 0 || (eligible.length > 1 && eligible.length !== failed.length)) {
    return null;
  }
  return validateReleaseFlakeIntent(
    {
      version: 1,
      parentRunId: plan.parentRunId,
      executionPlanSha256: plan.sha256,
      child: child.key,
      runId: child.runId,
      sourceRunAttempt: 1,
      expectedRunAttempt: 2,
      mode: eligible.length === 1 ? "job" : "failed",
      jobs: eligible
        .toSorted((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
        .map((job) => ({
          id: String(job.id),
          name: job.name,
          conclusion: job.conclusion,
        })),
    },
    plan,
  );
}

export function validateReleaseFlakeRecords(records, plan, children) {
  if (!Array.isArray(records) || records.length > plan.children.length) {
    throw new Error("automatic retry records are invalid");
  }
  const seen = new Set();
  for (const record of records) {
    const child = plan.children.find((entry) => entry.key === record?.child);
    if (
      !child?.selected ||
      record.executionPlanSha256 !== plan.sha256 ||
      !plan.knownFlakyJobs?.some((selector) => selector.startsWith(`${child.key}:`))
    ) {
      throw new Error("automatic retry record differs from the execution plan");
    }
    if (seen.has(child.key)) {
      throw new Error("automatic retry records duplicate a child");
    }
    seen.add(child.key);
    if (
      !exactKeys(record, ["child", "executionPlanSha256", "intent", "outcome", "replacements"]) ||
      !["not-attempted", "observed", "unknown", "rejected"].includes(record.outcome) ||
      !Array.isArray(record.replacements)
    ) {
      throw new Error("automatic retry record is invalid");
    }
    if (record.intent === null) {
      if (record.outcome !== "not-attempted" || record.replacements.length !== 0) {
        throw new Error("automatic retry omission is invalid");
      }
      continue;
    }
    const intent = validateReleaseFlakeIntent(record.intent, plan);
    if (intent.child !== child.key || record.outcome === "not-attempted") {
      throw new Error("automatic retry intent differs from its record");
    }
    if (record.outcome === "observed") {
      if (
        record.replacements.length !== intent.jobs.length ||
        new Set(record.replacements.map((job) => job.id)).size !== record.replacements.length ||
        record.replacements.some(
          (job, index) =>
            !exactKeys(job, ["id", "name", "runAttempt"]) ||
            !id(job.id) ||
            job.id === intent.jobs[index].id ||
            job.name !== intent.jobs[index].name ||
            job.runAttempt !== 2,
        )
      ) {
        throw new Error("automatic retry replacement evidence is invalid");
      }
      const observed = children?.[intent.child];
      if (
        observed &&
        (observed.runId !== intent.runId || !observed.observedRunAttempts?.includes(2))
      ) {
        throw new Error("automatic retry is absent from child attempt evidence");
      }
    } else if (record.replacements.length !== 0) {
      throw new Error("unresolved automatic retry contains replacement evidence");
    }
  }
  return records.toSorted((left, right) =>
    left.child < right.child ? -1 : left.child > right.child ? 1 : 0,
  );
}
