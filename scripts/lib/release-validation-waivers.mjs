import { isDeepStrictEqual } from "node:util";
import { compareAscii } from "./canonical-json.mjs";

// Reviewed release-tooling policy, loaded from P, never the candidate checkout.
// Add an exact version, child role, job name, and reason here to grant a waiver.
/** @type {import("./release-validation-waivers.mjs").ReleaseValidationWaiver[]} */
export const RELEASE_VALIDATION_WAIVERS = [
  {
    targetVersion: "2026.9.37",
    childRole: "productPerformance",
    jobName: "Kova mock provider performance",
    evidence: { runId: "42361846301", runAttempt: 1 },
    qualificationExemption: {
      targetSha: "5ca478fb3d02d7d988ce09cfcc214ec1eed46ab8",
      runId: 42361846301,
      runAttempt: 1,
      workflowRef: "release-ci/5ca478fb3d02-110230586240863827911794045203864",
      sourceParentRunId: "42361691019",
      sourceParentAttempt: 1,
      artifactId: 13570296857,
      artifactDigest: "sha256:3d4c6c1be8b31c2fac6dc636d4b72e5e920d5feaca80711d1f81fca6f737bfe6",
      artifactSizeBytes: 1104,
      receiptSha256: "5f52379d07a1cef385b598142889ec56514c99afc4575f1643442227bd5a53be",
    },
    reason:
      "Dallin Romney authorized the 2026.9.37 performance exception on " +
      "2026-11-07 at 17:08 UTC (FRV 42361691019/1; C/Q " +
      "5ca478fb3d02d7d988ce09cfcc214ec1eed46ab8). The retained report " +
      "kova-261107-095817-423747 has only the bundled-plugin-startup " +
      "gateway maxCpuPercent breach (483 > 360). Only this reviewed child " +
      "attempt is waived; retain its raw failure and report. Other failures, " +
      "missing evidence, and later attempts remain blocking. At 17:49 UTC " +
      "the operator additionally authorized a new candidate qualification " +
      "with performance explicitly waived-not-run. The old receipt supports " +
      "that exception only; it does not measure or qualify the new candidate.",
  },
  {
    targetVersion: "2026.11.3",
    childRole: "productPerformance",
    jobName: "Kova mock provider performance",
    reason:
      "Dallin Romney explicitly authorized the 2026.11.3 Kova waiver on " +
      "2026-11-10 at 03:34 UTC after reviewing FRV 42733555990/1, child " +
      "42734139245/1 on prior C fb9ce54d: RSS 1809.8-1819.6 MB > 1800 MB, " +
      "peak gateway CPU 433.7% > 340%, and process-tree CPU 467.4% > 360%. " +
      "Like 2026.11.2, this matches the exact version, child role, and failed " +
      "Kova job; it does not classify individual metrics within that job. " +
      "Retain raw failures. The prior run does not qualify new C 40223c5cc262; " +
      "there is no not-run exemption. Other failed jobs, missing or cancelled " +
      "evidence, and all other normal release gates remain blocking.",
  },
  {
    targetVersion: "2026.11.2",
    childRole: "productPerformance",
    jobName: "Kova mock provider performance",
    reason:
      "Dallin Romney authorized 2026.11.2-only Kova CPU/RSS threshold leniency on " +
      "2026-11-07 at 00:28 UTC (FRV 42308858515, kova-261106-230743-bd1e4d). " +
      "Retain raw failed performance evidence; crash, correctness, isolation, " +
      "data-integrity, and install/update failures remain blocking.",
  },
  {
    targetVersion: "2026.11.1",
    childRole: "productPerformance",
    jobName: "Kova mock provider performance",
    reason:
      "Operator-authorized 2026.11.1-only leniency: Kova CPU and RSS thresholds exceeded " +
      "(FRV 41800680256 run kova-261104-084310-8bd049); crash, correctness, isolation, " +
      "data-integrity, and install/update failures stay blocking and are checked in the report.",
  },
  {
    targetVersion: "2026.11.1",
    childRole: "releaseChecksIndependent",
    jobName: "Run repo/live E2E validation / validate_release_live_cache",
    reason:
      "OpenRouter returned HTTP 402 for the release key (FRV 41881174354 job on C 3a4983e15f96); " +
      "billing failure at the last provider, tracked in the 2026.11.1 release handoff.",
  },
];

// This is an explicit not-run disposition for a new C/Q, not reuse of the old
// measurement. Only P may seal it into independently authenticated coverage.
export function releaseQualificationExemptions(targetVersion, profile) {
  if (!["stable", "full"].includes(profile)) {
    return [];
  }
  return RELEASE_VALIDATION_WAIVERS.filter(
    (waiver) => waiver.targetVersion === targetVersion && waiver.qualificationExemption,
  ).map((waiver) => ({
    childRole: waiver.childRole,
    targetVersion: waiver.targetVersion,
    disposition: "waived-not-run",
    reason: waiver.reason,
    supportingEvidence: waiver.qualificationExemption,
  }));
}

export function validateQualificationExemptions(exemptions, targetVersion, profile) {
  if (!isDeepStrictEqual(exemptions, releaseQualificationExemptions(targetVersion, profile))) {
    throw new Error("Qualification exemptions differ from current release-tooling policy");
  }
}

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
  if (waiver.childRole === "npmTelegram" && waiver.jobName === "Run package Telegram E2E") {
    return [];
  }
  if (waiver.childRole === "productPerformance" && waiver.jobName === KOVA_PERFORMANCE_JOB) {
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
      // A reviewed historical failure never grants leniency to a new execution.
      (!waiver.evidence ||
        (waiver.evidence.runId === child.runId &&
          waiver.evidence.runAttempt === child.runAttempt)) &&
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
    const causes = log
      .split(/\r?\n/u)
      .filter((line) => !line.includes("\u001b"))
      .flatMap((line) => {
        const match = /(?:##\[error\]|::error::)(.*)$/u.exec(line);
        return match && match[1] !== "Process completed with exit code 1." ? [match[1]] : [];
      });
    if (causes.length === 0 || causes.some((cause) => !aggregate.causes.includes(cause))) {
      throw new ReleaseAggregateValidationError(
        `Release aggregate has an unwaived failure: ${aggregate.jobName}`,
      );
    }
  }
}
