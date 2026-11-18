import { compareAscii } from "./canonical-json.mjs";

// Observed failed leaves from FRV 44290981153 and 44310687628; cancelled
// workloads are deliberately absent. These are job-level, not test-level grants.
const STABLE_116_CI_FAILURES = new Map([
  ...[
    "checks-node-compact-large-16 (node)",
    "checks-node-compact-large-28 (bun)",
    "checks-node-compact-large-28 (node)",
    "checks-node-compact-large-31 (node)",
    "checks-node-compact-large-32 (bun)",
    "checks-node-compact-large-37 (bun)",
    "checks-node-compact-large-42 (bun)",
    "checks-node-compact-large-8 (node)",
    "checks-node-compact-small-12 (node)",
  ].map((name) => [name, "checks-node-core-test-nondist-shard"]),
  ["checks-node-compat-node24", "checks-node-compat"],
  ["checks-ui (3/3)", "checks-ui"],
  ["checks-ui-e2e (10/13)", "checks-ui-e2e"],
  ["checks-ui-e2e-real-gateway (2/2)", "checks-ui-e2e-real-gateway"],
]);

// Reviewed release-tooling policy, loaded from P, never the candidate checkout.
// Add an exact version, child role, job name, and reason here to grant a waiver.
/** @type {{ targetVersion: string, childRole: string, jobName: string, reason: string }[]} */
export const RELEASE_VALIDATION_WAIVERS = [
  ...[...STABLE_116_CI_FAILURES.keys()].map((jobName) => ({
    targetVersion: "2026.11.6",
    childRole: "normalCi",
    jobName,
    reason:
      "Accept the observed 2026.11.6 CI leaf failure while retaining raw results, required execution, aggregate cause validation, and integrity gates.",
  })),
  ...[
    "Run repo/live E2E validation / Gateway E2E / Repo E2E (Gateway 3/4)",
    "Run repo/live E2E validation / Native live suites (Native live agents)",
    "Run repo/live E2E validation / Native live suites (Native live gateway core)",
    "Run repo/live E2E validation / Native live suites (Native live gateway OpenAI GPT-5.6 Ultra)",
    "Run repo/live E2E validation / Native live suites (Native live test harnesses)",
    "Run repo/live E2E validation / UI and plugin E2E / Repo E2E (UI 2/4)",
  ].map((jobName) => ({
    targetVersion: "2026.11.6",
    childRole: "releaseChecksIndependent",
    jobName,
    reason:
      "Accept the observed 2026.11.6 repo/live leaf failure while retaining raw results, required execution, aggregate cause validation, and integrity gates.",
  })),
  {
    targetVersion: "2026.11.6",
    childRole: "productPerformance",
    jobName: "Kova mock provider performance",
    reason:
      "Dallin Romney explicitly authorized the 2026.11.6 Kova waiver on " +
      "2026-11-18 at 06:30 UTC while requiring continued cold-turn investigation. " +
      "The prior cold-turn comparison showed a 13341 ms median versus 6515 ms " +
      "on 2026.11.5; transient noise or a causal regression is not established. " +
      "This release-wide grant accepts only the named Kova threshold failures, " +
      "not evidence of a fix or non-regression. Preserve raw measurements and " +
      "required execution; no threshold changes or not-run exemption. Other " +
      "jobs, missing or cancelled evidence, build/setup, crashes, correctness, " +
      "isolation, data integrity, install/update and publication gates remain blocking.",
  },
];

const SUCCESSFUL_CONCLUSIONS = new Set(["success", "skipped", "neutral"]);
const RELEASE_CHECK_ROLES = new Set([
  "releaseChecks",
  "releaseChecksIndependent",
  "releaseChecksCandidate",
]);

export function isFailedReleaseJob(job) {
  return job.status === "completed" && !SUCCESSFUL_CONCLUSIONS.has(job.conclusion);
}

const WINDOWS_NODE_STABLE_JOB =
  "Run Windows-node stable E2E / Setup, connect, and invoke candidate gateway";
const WINDOWS_NODE_ADVISORY_JOBS = new Set([
  "Resolve Windows-node main source",
  "Run Windows-node prerelease E2E / Setup, connect, and invoke candidate gateway",
  "Run Windows-node main E2E / Setup, connect, and invoke candidate gateway",
]);

function isReleaseAdvisoryJob(childKey, job) {
  return (
    childKey === "releaseChecksCandidate" &&
    (WINDOWS_NODE_ADVISORY_JOBS.has(job.name) ||
      (job.status === "completed" &&
        job.conclusion === "skipped" &&
        ["Run Windows-node prerelease E2E", "Run Windows-node main E2E"].includes(job.name)))
  );
}

export function releaseChildAdvisories(child) {
  if (child.key !== "releaseChecksCandidate") {
    return [];
  }
  const stableRan = child.jobs.some(
    (job) => job.name === WINDOWS_NODE_STABLE_JOB && job.conclusion !== "skipped",
  );
  return child.jobs
    .filter(
      (job) =>
        isReleaseAdvisoryJob(child.key, job) &&
        (isFailedReleaseJob(job) || (stableRan && job.conclusion === "skipped")),
    )
    .map((job) => ({
      class: "windows-node-preview",
      child: child.key,
      job: job.name,
      conclusion: job.conclusion,
      runId: String(child.runId),
      url: job.html_url ?? job.url ?? "",
    }))
    .toSorted((left, right) => compareAscii(left.job, right.job));
}

const KOVA_PERFORMANCE_JOB = "Kova mock provider performance";

function aggregateCauses(waiver) {
  if (
    waiver.targetVersion === "2026.11.6" &&
    waiver.childRole === "normalCi" &&
    STABLE_116_CI_FAILURES.has(waiver.jobName)
  ) {
    return [
      {
        jobName: "openclaw/ci-gate",
        stepName: "Verify selected CI lanes",
        causes: [
          STABLE_116_CI_FAILURES.get(waiver.jobName) + " finished with failure (selected=true)",
        ],
        exactCauses: true,
      },
    ];
  }
  if (waiver.childRole === "productPerformance" && waiver.jobName === KOVA_PERFORMANCE_JOB) {
    return [];
  }
  if (waiver.childRole === "npmTelegram" && waiver.jobName === "Run package Telegram E2E") {
    return [];
  }
  if (RELEASE_CHECK_ROLES.has(waiver.childRole)) {
    let cause;
    const aggregates = [];
    if (waiver.jobName.startsWith("Run repo/live E2E validation / ")) {
      cause = "live_repo_e2e_release_checks ended with failure";
    } else if (waiver.jobName === "Run QA Lab live Telegram lane") {
      cause = "qa_live_telegram_release_checks ended with failure";
    } else if (
      waiver.jobName ===
      "Run package acceptance / Telegram package acceptance / Run package Telegram E2E"
    ) {
      cause = "package_acceptance_release_checks ended with failure";
      aggregates.push({
        jobName: "Run package acceptance / Verify package acceptance",
        stepName: "Verify package acceptance results",
        causes: ["package_telegram ended with failure"],
      });
    }
    if (cause) {
      return [
        ...aggregates,
        {
          jobName: "Verify release checks",
          stepName: "Verify release check results",
          causes: [cause],
          ...(waiver.targetVersion === "2026.11.6" ? { exactCauses: true } : {}),
        },
      ];
    }
  }
  throw new Error(`Release waiver is not a live-provider/Telegram job: ${waiver.jobName}`);
}

// Raw leaf and workflow conclusions are never rewritten. The caller owns the
// aggregate validation verdict and must also authenticate failed aggregate logs.
export function evaluateReleaseChildPolicy({ child, targetVersion }) {
  const waivers = RELEASE_VALIDATION_WAIVERS.filter(
    (waiver) =>
      waiver.targetVersion === targetVersion &&
      waiver.childRole === child.key &&
      child.jobs.some(
        (job) =>
          job.name === waiver.jobName && job.status === "completed" && job.conclusion === "failure",
      ),
  );
  const aggregates = new Map();
  for (const waiver of waivers) {
    for (const aggregate of aggregateCauses(waiver)) {
      const existing = aggregates.get(aggregate.jobName);
      if (existing) {
        existing.causes = [...new Set([...existing.causes, ...aggregate.causes])];
      } else {
        aggregates.set(aggregate.jobName, aggregate);
      }
    }
  }
  const waivedJobNames = new Set([
    ...waivers.map((row) => row.jobName),
    ...child.jobs
      .filter(
        (job) =>
          aggregates.has(job.name) && job.status === "completed" && job.conclusion === "failure",
      )
      .map((job) => job.name),
  ]);
  const advisoryJobs = child.jobs.filter((job) => isReleaseAdvisoryJob(child.key, job));
  // Preview failures retain their raw conclusions. Stable compatibility and the
  // verifier must still pass; an existing tooling waiver keeps its own log checks.
  const advisoryFailureAllowed =
    !advisoryJobs.some(isFailedReleaseJob) ||
    [WINDOWS_NODE_STABLE_JOB, "Verify release checks"].every((name) =>
      child.jobs.some(
        (job) =>
          job.name === name &&
          job.status === "completed" &&
          (job.conclusion === "success" || waivedJobNames.has(name)),
      ),
    );
  return {
    waivers,
    aggregates: [...aggregates.values()],
    waivedJobNames,
    advisoryJobs,
    advisoryFailureAllowed,
    blockingJobs: child.jobs.filter(
      (job) =>
        isFailedReleaseJob(job) &&
        !waivedJobNames.has(job.name) &&
        !isReleaseAdvisoryJob(child.key, job),
    ),
  };
}

// Aggregates also enforce integrity and dispatch identity. A waived test must
// not excuse a second failure in that same aggregate job.
export class ReleaseAggregateValidationError extends Error {}

// Ignore echoed shell source, not error records: only line-leading runner
// annotations (after a timestamp and optional color) are observed causes.
function exactAggregateCauses(log) {
  return log.split(/\r?\n/u).flatMap((line) => {
    const record = line
      // eslint-disable-next-line no-control-regex -- Only SGR color is removed; other controls fail closed.
      .replace(/\u001b\[[0-9;]*m/gu, "")
      .replace(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z /u, "");
    const match = /^(?:##\[error\]|::error(?: title=CI job did not succeed)?::)(.*)$/u.exec(record);
    if (match) {
      return match[1] === "Process completed with exit code 1." ? [] : [match[1]];
    }
    // Malformed error records and remaining control characters fail closed.
    return /^(?:##\[error|::error)/u.test(record) ||
      // eslint-disable-next-line no-control-regex -- Reject controls that could conceal an error record.
      /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/u.test(record)
      ? [record]
      : [];
  });
}

export async function validateReleaseWaiverAggregates({ policy, jobs, getJobLog }) {
  for (const aggregate of policy.aggregates) {
    const matches = jobs.filter((job) => job.name === aggregate.jobName);
    if (matches.length !== 1 || matches[0].status !== "completed") {
      throw new ReleaseAggregateValidationError(
        `Required release aggregate is missing or incomplete: ${aggregate.jobName}`,
      );
    }
    const job = matches[0];
    if (job.conclusion === "success") {
      continue;
    }
    const failedSteps = job.steps?.filter(
      (step) => !["success", "skipped"].includes(step.conclusion),
    );
    if (
      job.conclusion !== "failure" ||
      failedSteps?.length !== 1 ||
      failedSteps[0].name !== aggregate.stepName
    ) {
      throw new ReleaseAggregateValidationError(
        `Release aggregate has a non-policy failure: ${aggregate.jobName}`,
      );
    }
    const log = String(await getJobLog(job.id));
    const causes = aggregate.exactCauses
      ? exactAggregateCauses(log)
      : log
          .split(/\r?\n/u)
          .filter((line) => !line.includes("\u001b"))
          .flatMap((line) => {
            const match = /(?:##\[error\]|::error::)(.*)$/u.exec(line);
            return match && match[1] !== "Process completed with exit code 1." ? [match[1]] : [];
          });
    if (
      causes.length === 0 ||
      causes.some((cause) => !aggregate.causes.includes(cause)) ||
      (aggregate.exactCauses &&
        (causes.length !== aggregate.causes.length || new Set(causes).size !== causes.length))
    ) {
      throw new ReleaseAggregateValidationError(
        `Release aggregate has an unwaived failure: ${aggregate.jobName}`,
      );
    }
  }
}
