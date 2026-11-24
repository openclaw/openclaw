import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { compareAscii } from "./canonical-json.mjs";
import { parseNodeFailureReport } from "./ci-node-test-evidence.mjs";
import defaultWaiverPolicy from "./release-validation-waivers.json" with { type: "json" };

export const RELEASE_VALIDATION_WAIVERS_PATH = "scripts/lib/release-validation-waivers.json";
export function readReleaseValidationWaivers(readSource) {
  return parseReleaseValidationWaivers(readSource(RELEASE_VALIDATION_WAIVERS_PATH));
}

export async function readReleaseValidationWaiversAsync(readSource) {
  return parseReleaseValidationWaivers(await readSource(RELEASE_VALIDATION_WAIVERS_PATH));
}

function waiverEvidenceRunId(value) {
  return typeof value === "string" && /^[1-9][0-9]*$/u.test(value)
    ? value
    : Number.isSafeInteger(value) && value > 0
      ? String(value)
      : undefined;
}

export function releaseWaiverEvidenceMatches(evidence, runId, runAttempt) {
  const id = waiverEvidenceRunId(evidence?.runId);
  return (
    id !== undefined &&
    id === runId &&
    Number.isSafeInteger(evidence.runAttempt) &&
    evidence.runAttempt > 0 &&
    evidence.runAttempt === runAttempt
  );
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
      !["targetVersion", "childRole", "jobName", "reason"].every(
        (key) => typeof waiver[key] === "string" && waiver[key].length > 0,
      ) ||
      (waiver.targetSha !== undefined && !/^[a-f0-9]{40}$/u.test(waiver.targetSha)) ||
      (waiver.evidence !== undefined &&
        (waiverEvidenceRunId(waiver.evidence?.runId) === undefined ||
          !Number.isSafeInteger(waiver.evidence.runAttempt) ||
          waiver.evidence.runAttempt <= 0)) ||
      (waiver.cancelledStep !== undefined &&
        (typeof waiver.cancelledStep !== "string" ||
          waiver.cancelledStep.length === 0 ||
          waiver.testFailures !== undefined)) ||
      !Array.isArray(waiver.aggregates) ||
      waiver.aggregates.some(
        (aggregate) =>
          !aggregate ||
          typeof aggregate.jobName !== "string" ||
          typeof aggregate.stepName !== "string" ||
          !Array.isArray(aggregate.causes) ||
          !aggregate.causes.every((cause) => typeof cause === "string") ||
          (aggregate.exactCauses !== undefined && typeof aggregate.exactCauses !== "boolean") ||
          (aggregate.logSha256 !== undefined && !/^[a-f0-9]{64}$/u.test(aggregate.logSha256)),
      )
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

// Raw leaf and workflow conclusions are never rewritten. The caller owns the
// aggregate validation verdict and must also authenticate failed aggregate logs.
export function evaluateReleaseChildPolicy({
  child,
  targetVersion,
  targetSha,
  waiverPolicy = RELEASE_VALIDATION_WAIVERS,
}) {
  const matches = waiverPolicy.filter(
    (waiver) =>
      waiver.targetVersion === targetVersion &&
      (waiver.targetSha === undefined || waiver.targetSha === targetSha) &&
      waiver.childRole === child.key &&
      // A reviewed historical failure never grants leniency to a new execution.
      (!waiver.evidence ||
        releaseWaiverEvidenceMatches(waiver.evidence, child.runId, child.runAttempt)) &&
      child.jobs.some(
        (job) =>
          job.name === waiver.jobName &&
          job.status === "completed" &&
          job.conclusion === (waiver.cancelledStep ? "cancelled" : "failure"),
      ),
  );
  const aggregates = new Map();
  for (const waiver of matches) {
    for (const aggregate of waiver.aggregates ?? []) {
      const existing = aggregates.get(aggregate.jobName);
      if (existing) {
        existing.causes = [...new Set([...existing.causes, ...aggregate.causes])];
      } else {
        // Union only this evaluation; the immutable Q policy is reused by siblings.
        aggregates.set(aggregate.jobName, { ...aggregate, causes: [...aggregate.causes] });
      }
    }
  }
  // Preserve the established manifest shape; aggregate declarations are Q policy,
  // not a replacement for authenticated original aggregate logs.
  const waivers = matches.map(({ aggregates: _aggregates, ...waiver }) => waiver);
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
  for (const waiver of policy.waivers) {
    if (waiver.cancelledStep) {
      const matches = jobs.filter((job) => job.name === waiver.jobName);
      const job = matches[0];
      const incompleteSteps = job?.steps?.filter(
        (step) => !["success", "skipped"].includes(step.conclusion),
      );
      if (
        matches.length !== 1 ||
        job.status !== "completed" ||
        job.conclusion !== "cancelled" ||
        incompleteSteps?.length !== 1 ||
        incompleteSteps[0].name !== waiver.cancelledStep ||
        incompleteSteps[0].conclusion !== "cancelled"
      ) {
        throw new ReleaseAggregateValidationError(
          `Release test job has a non-policy cancellation: ${waiver.jobName}`,
        );
      }
      continue;
    }
    if (!waiver.testFailures) {
      continue;
    }
    const matches = jobs.filter((job) => job.name === waiver.jobName);
    const job = matches[0];
    const failedSteps = job?.steps?.filter(
      (step) => !["success", "skipped"].includes(step.conclusion),
    );
    if (
      matches.length !== 1 ||
      job.status !== "completed" ||
      job.conclusion !== "failure" ||
      failedSteps?.length !== 1 ||
      failedSteps[0].conclusion !== "failure" ||
      failedSteps[0].name !== waiver.testFailures.stepName
    ) {
      throw new ReleaseAggregateValidationError(
        `Release test job has a non-policy failure: ${waiver.jobName}`,
      );
    }
    const signatures = parseNodeFailureReport(String(await getJobLog(job.id)), true);
    if (
      ![waiver.testFailures.signatures, ...(waiver.testFailures.alternativeSignatures ?? [])].some(
        (accepted) => isDeepStrictEqual(signatures, accepted),
      )
    ) {
      throw new ReleaseAggregateValidationError(
        `Release test job has an unwaived or incomplete failure: ${waiver.jobName}`,
      );
    }
  }
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
    if (aggregate.logSha256) {
      if (createHash("sha256").update(log).digest("hex") !== aggregate.logSha256) {
        throw new ReleaseAggregateValidationError(
          "Release aggregate differs from reviewed evidence: " + aggregate.jobName,
        );
      }
      continue;
    }
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
