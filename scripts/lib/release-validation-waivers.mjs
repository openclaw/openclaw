import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { compareAscii } from "./canonical-json.mjs";
import defaultWaiverPolicy from "./release-validation-waivers.json" with { type: "json" };

export const RELEASE_VALIDATION_WAIVERS_PATH = "scripts/lib/release-validation-waivers.json";
export function readReleaseValidationWaivers(readSource) {
  return parseReleaseValidationWaivers(readSource(RELEASE_VALIDATION_WAIVERS_PATH));
}

export async function readReleaseValidationWaiversAsync(readSource) {
  return parseReleaseValidationWaivers(await readSource(RELEASE_VALIDATION_WAIVERS_PATH));
}

export function parseReleaseValidationWaivers(source) {
  const policy = JSON.parse(source);
  if (
    policy?.schema !== "openclaw.release-validation-waivers/v1" ||
    !Array.isArray(policy.waivers) ||
    policy.waivers.length > 512
  ) {
    throw new Error("Invalid release waiver policy");
  }
  for (const waiver of policy.waivers) {
    if (
      !waiver ||
      Object.keys(waiver).some(
        (key) =>
          ![
            "targetVersion",
            "targetSha",
            "childRole",
            "jobName",
            "reason",
            "step",
            "qualificationExemption",
            "aggregates",
            "cancelledStep",
            "evidence",
            "testFailures",
          ].includes(key),
      ) ||
      !["targetVersion", "childRole", "reason"].every(
        (key) => typeof waiver[key] === "string" && waiver[key].trim(),
      ) ||
      (waiver.jobName !== undefined &&
        (typeof waiver.jobName !== "string" || !waiver.jobName.trim())) ||
      (waiver.step !== undefined &&
        (waiver.jobName === undefined || typeof waiver.step !== "string" || !waiver.step.trim())) ||
      (waiver.aggregates === undefined
        ? ["cancelledStep", "evidence", "testFailures"].some((key) => Object.hasOwn(waiver, key))
        : waiver.jobName === undefined ||
          waiver.step !== undefined ||
          !Array.isArray(waiver.aggregates) ||
          waiver.aggregates.some(
            (entry) =>
              !entry ||
              typeof entry.jobName !== "string" ||
              typeof entry.stepName !== "string" ||
              !Array.isArray(entry.causes) ||
              !entry.causes.every((cause) => typeof cause === "string") ||
              (entry.exactCauses !== undefined && typeof entry.exactCauses !== "boolean") ||
              (entry.logSha256 !== undefined && !/^[a-f0-9]{64}$/u.test(entry.logSha256)),
          )) ||
      (waiver.targetSha !== undefined &&
        (typeof waiver.targetSha !== "string" || !/^[a-f0-9]{40}$/u.test(waiver.targetSha)))
    ) {
      throw new Error("Invalid release waiver entry");
    }
  }
  return policy.waivers;
}

// Only immutable Q data crosses the verifier boundary, never Q executable code.
export function decodeReleaseValidationSource(payload, sourcePath) {
  if (
    payload?.path !== sourcePath ||
    payload.type !== "file" ||
    payload.encoding !== "base64" ||
    !Number.isSafeInteger(payload.size) ||
    payload.size < 1 ||
    payload.size > 1024 * 1024 ||
    typeof payload.content !== "string"
  ) {
    throw new Error("Invalid immutable Q waiver source");
  }
  const bytes = Buffer.from(payload.content, "base64");
  const header = "blob " + bytes.length + "\0";
  if (
    bytes.length !== payload.size ||
    createHash("sha1").update(header).update(bytes).digest("hex") !== payload.sha
  ) {
    throw new Error("Q waiver source blob mismatch");
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

const RELEASE_VALIDATION_WAIVERS = parseReleaseValidationWaivers(
  process.env.OPENCLAW_RELEASE_WAIVERS_PATH
    ? readFileSync(process.env.OPENCLAW_RELEASE_WAIVERS_PATH, "utf8")
    : JSON.stringify(defaultWaiverPolicy),
);

// This is an explicit not-run disposition for a new C/Q, not reuse of the old
// measurement. Only P may seal it into independently authenticated coverage.
export function releaseQualificationExemptions(
  targetVersion,
  profile,
  waivers = RELEASE_VALIDATION_WAIVERS,
) {
  if (!["stable", "full"].includes(profile)) {
    return [];
  }
  return waivers
    .filter((waiver) => waiver.targetVersion === targetVersion && waiver.qualificationExemption)
    .map((waiver) => ({
      childRole: waiver.childRole,
      targetVersion: waiver.targetVersion,
      disposition: "waived-not-run",
      reason: waiver.reason,
      supportingEvidence: waiver.qualificationExemption,
    }));
}

export function validateQualificationExemptions(
  exemptions,
  targetVersion,
  profile,
  waivers = RELEASE_VALIDATION_WAIVERS,
) {
  if (
    !isDeepStrictEqual(exemptions, releaseQualificationExemptions(targetVersion, profile, waivers))
  ) {
    throw new Error("Qualification exemptions differ from current release-tooling policy");
  }
}

export function firstIncompleteReleaseStep(steps) {
  const step = steps?.find(({ conclusion }) => !["success", "skipped"].includes(conclusion));
  return step?.conclusion || step?.status === "in_progress" || step?.status === "queued"
    ? step.name
    : undefined;
}

// Omitting the queried job asks whether the whole child is waived.
export function isWaived(
  { targetVersion, targetSha, childRole, jobName, job },
  waivers = RELEASE_VALIDATION_WAIVERS,
) {
  return waivers.some(
    (waiver) =>
      !waiver.qualificationExemption &&
      waiver.targetVersion === targetVersion &&
      (waiver.targetSha === undefined || waiver.targetSha === targetSha) &&
      waiver.childRole === childRole &&
      (waiver.jobName === undefined || waiver.jobName === jobName) &&
      // Frozen v1 rows keep their original failure-only scope. Do not convert
      // evidence-bound or aggregate exceptions into unconditional grants.
      (waiver.aggregates === undefined ||
        (waiver.aggregates.length === 0 &&
          waiver.cancelledStep === undefined &&
          waiver.evidence === undefined &&
          waiver.testFailures === undefined &&
          job?.status === "completed" &&
          job.conclusion === "failure")) &&
      (waiver.step === undefined ||
        (job?.status === "completed" &&
          job.conclusion !== "success" &&
          waiver.step === (job.firstIncompleteStep ?? firstIncompleteReleaseStep(job.steps)))),
  );
}

const SUCCESSFUL_CONCLUSIONS = new Set(["success", "skipped", "neutral"]);

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

// Evaluate the blocking inventory without rewriting raw job results.
export function evaluateReleaseChildPolicy({
  child,
  targetVersion,
  targetSha,
  waiverPolicy = RELEASE_VALIDATION_WAIVERS,
  requiredJobs = [],
}) {
  const scope = { targetVersion, targetSha, childRole: child.key };
  const workflowWaived = isWaived(scope, waiverPolicy);
  const jobs = new Map(child.jobs.map((job) => [job.name, job]));
  const jobScope = (jobName) => ({ ...scope, jobName, job: jobs.get(jobName) });
  const matching = waiverPolicy.filter((waiver) => isWaived(jobScope(waiver.jobName), [waiver]));
  const waivers = matching
    .filter(({ jobName }) => {
      const job = jobs.get(jobName);
      return (
        jobName === undefined ||
        job?.status !== "completed" ||
        isFailedReleaseJob(job) ||
        (job.conclusion === "skipped" && requiredJobs.includes(jobName))
      );
    })
    // The frozen manifest recorded used exceptions, never the ledger-only aggregates field.
    .map(({ aggregates: _aggregates, ...waiver }) => waiver);
  const waivedJobNames = new Set(
    [...requiredJobs, ...jobs.keys()].filter((jobName) => isWaived(jobScope(jobName), matching)),
  );
  const advisoryJobs = child.jobs.filter((job) => isReleaseAdvisoryJob(child.key, job));
  // Preview failures retain their raw conclusions. Stable compatibility and the
  // verifier must still pass unless explicitly waived.
  const advisoryFailureAllowed =
    workflowWaived ||
    !advisoryJobs.some(isFailedReleaseJob) ||
    [WINDOWS_NODE_STABLE_JOB, "Verify release checks"].every(
      (name) =>
        isWaived(jobScope(name), matching) ||
        (jobs.get(name)?.status === "completed" && jobs.get(name)?.conclusion === "success"),
    );
  return {
    waivers,
    workflowWaived,
    waivedWorkDidNotPass: [...waivedJobNames].some((jobName) => {
      const job = jobs.get(jobName);
      return job
        ? job.status !== "completed" ||
            isFailedReleaseJob(job) ||
            (job.conclusion === "skipped" && requiredJobs.includes(jobName))
        : requiredJobs.includes(jobName);
    }),
    waivedJobNames,
    missingRequiredJobs:
      child.status === "completed"
        ? requiredJobs.filter(
            (name) =>
              !waivedJobNames.has(name) &&
              !child.jobs.some((job) => job.name === name && job.conclusion !== "skipped"),
          )
        : [],
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
