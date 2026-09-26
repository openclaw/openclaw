import { createHash } from "node:crypto";
import process from "node:process";
import {
  composeReleaseChildAttemptEvidence,
  releaseChildSpec,
  releaseCompositeJobsSha256,
  validateReleaseChildRunProvenance,
} from "../full-release-validation-policy.mjs";
import {
  downloadExactActionsArtifactArchive,
  inspectActionsArtifactZip,
} from "./actions-artifact-archive.mjs";
import { canonicalizeJsonValue } from "./canonical-json.mjs";
import {
  FULL_RELEASE_CHILD_EVIDENCE_JOB as PUBLISHER_JOB,
  MAX_RELEASE_ARTIFACT_BYTES,
} from "./full-release-evidence.mjs";
import { execGhRead, execGhReadAsync } from "./plain-gh.mjs";
import { isRecord } from "./record-shared.mjs";

const MAX_RUNS = 30;
const MAX_CANDIDATES = 5;
const MAX_ATTEMPTS = 32;
const MAX_JOB_PAGES = 20;
const RECEIPT_FILE = "full-release-child-evidence.json";
const SHA = /^[a-f0-9]{40}$/u;
const DIGEST = /^sha256:[a-f0-9]{64}$/u;

function requireEvidence(condition, message) {
  if (!condition) {
    throw new Error(`Full release child evidence ${message}`);
  }
}

function positiveInteger(value) {
  return Number.isSafeInteger(Number(value)) && Number(value) > 0;
}

function canonical(value) {
  return JSON.stringify(canonicalizeJsonValue(value));
}

function normalizedInputs(inputs) {
  requireEvidence(
    isRecord(inputs) &&
      Object.values(inputs).every((value) =>
        ["string", "boolean", "number"].includes(typeof value),
      ),
    "requires scalar dispatch inputs",
  );
  return canonicalizeJsonValue(
    Object.fromEntries(
      Object.entries(inputs)
        .filter(([key]) => key !== "dispatch_id")
        .map(([key, value]) => [key, String(value)]),
    ),
  );
}

function requestValue(request) {
  requireEvidence(
    isRecord(request) &&
      /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(request.repository) &&
      SHA.test(request.targetSha),
    "request identity is invalid",
  );
  const spec = releaseChildSpec(request.role);
  return { ...request, inputs: normalizedInputs(request.inputs), spec };
}

function dependencies(repository, deps) {
  const deadlineMs = deps.deadlineMs ?? Date.now() + 120_000;
  const remaining = () => {
    const milliseconds = deadlineMs - Date.now();
    requireEvidence(milliseconds > 0, "verification exceeded its time budget");
    return milliseconds;
  };
  const github = async (endpoint) => {
    const timeout = Math.min(60_000, remaining());
    return deps.github
      ? deps.github(endpoint)
      : JSON.parse(
          await execGhReadAsync(["api", `repos/${repository}/${endpoint}`], {
            timeout,
            maxBuffer: 4 * 1024 * 1024,
            env: { ...process.env, OCTOPOOL_FRESH: "1" },
          }),
        );
  };
  return {
    github,
    downloadArchive:
      deps.downloadArchive ??
      (async (params) => {
        if (params.token) {
          return downloadExactActionsArtifactArchive(params);
        }
        // Local verifiers can use gh's authenticated session without exporting
        // its token. The shared verifier below still checks metadata and bytes.
        const archiveBytes = execGhRead(
          ["api", `repos/${repository}/actions/artifacts/${params.expected.artifactId}/zip`],
          {
            timeout: remaining(),
            killSignal: "SIGKILL",
            maxBuffer: MAX_RELEASE_ARTIFACT_BYTES,
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        return {
          archiveBytes,
          artifactMetadata: await github(`actions/artifacts/${params.expected.artifactId}`),
        };
      }),
    deadlineMs,
    now: deps.now ?? Date.now(),
    token: deps.token ?? process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN,
  };
}

function artifactName(request, runId, runAttempt) {
  return `full-release-child-evidence-${request.targetSha}-${request.role}-${runId}-${runAttempt}`;
}

function artifactIdentity(artifact, request, run, now) {
  requireEvidence(
    isRecord(artifact) &&
      positiveInteger(artifact.id) &&
      artifact.name === artifactName(request, run.id, run.run_attempt) &&
      artifact.expired === false &&
      DIGEST.test(artifact.digest) &&
      positiveInteger(artifact.size_in_bytes) &&
      artifact.size_in_bytes <= MAX_RELEASE_ARTIFACT_BYTES &&
      Date.parse(artifact.expires_at) > now &&
      String(artifact.workflow_run?.id) === String(run.id) &&
      artifact.workflow_run?.head_sha === run.head_sha &&
      artifact.workflow_run?.repository_id === run.repository?.id &&
      artifact.workflow_run?.head_repository_id === run.head_repository?.id &&
      positiveInteger(run.repository?.id) &&
      run.repository.id === run.head_repository?.id,
    "artifact identity, digest, or expiry is invalid",
  );
  return {
    id: String(artifact.id),
    name: artifact.name,
    digest: artifact.digest,
    expiresAt: artifact.expires_at,
    sizeInBytes: artifact.size_in_bytes,
  };
}

function expectedRun(selection, request) {
  return {
    key: request.role,
    repository: request.repository,
    runId: selection.runId,
    plannedRunAttempt: 1,
    displayTitle: selection.displayTitle,
    workflow: request.spec.workflow,
    workflowRef: selection.workflowRef,
    workflowSha: selection.workflowSha,
  };
}

function validateRun(run, selection, request) {
  validateReleaseChildRunProvenance(run, expectedRun(selection, request));
  requireEvidence(
    run.run_attempt === selection.runAttempt &&
      run.run_attempt <= MAX_ATTEMPTS &&
      run.status === "completed" &&
      run.conclusion === "success" &&
      run.head_repository?.full_name === request.repository,
    "child is not the current successful attempt",
  );
}

async function readAttemptJobs(github, run, runAttempt) {
  const jobs = [];
  let total;
  for (let page = 1; page <= MAX_JOB_PAGES; page += 1) {
    const inventory = await github(
      `actions/runs/${run.id}/attempts/${runAttempt}/jobs?per_page=100&page=${page}`,
    );
    total ??= inventory?.total_count;
    requireEvidence(
      positiveInteger(total) &&
        total <= MAX_JOB_PAGES * 100 &&
        inventory?.total_count === total &&
        Array.isArray(inventory.jobs) &&
        inventory.jobs.length > 0 &&
        inventory.jobs.every(
          (job) =>
            String(job.run_id) === String(run.id) &&
            job.run_attempt === runAttempt &&
            job.head_sha === run.head_sha &&
            job.status === "completed",
        ),
      "job inventory is incomplete or belongs to another attempt",
    );
    jobs.push(...inventory.jobs);
    if (jobs.length >= total) {
      requireEvidence(jobs.length === total, "job inventory count changed");
      return jobs;
    }
  }
  throw new Error("Full release child evidence job inventory exceeded its bound");
}

function validatePublisher(jobs, receipt) {
  const publishers = jobs.filter((job) => job.name === PUBLISHER_JOB);
  requireEvidence(
    publishers.length === 1 &&
      String(publishers[0].id) === receipt.publisher?.jobId &&
      receipt.publisher?.jobName === PUBLISHER_JOB,
    "publisher job identity is invalid",
  );
  // Job-level continue-on-error does not authenticate the upload. Both exact
  // steps must have succeeded, including when a later cleanup step failed.
  for (const name of [
    "Checkout trusted child evidence tooling",
    "Seal exact child attempt evidence",
    "Upload sealed child evidence",
  ]) {
    const steps = publishers[0].steps?.filter((step) => step.name === name) ?? [];
    requireEvidence(
      steps.length === 1 && steps[0].status === "completed" && steps[0].conclusion === "success",
      `publisher step did not succeed: ${name}`,
    );
  }
}

function origin(selection, request) {
  return `full-release-validation-${selection.sourceParentRunId}-${selection.sourceParentAttempt}${request.spec.suffix}`;
}

function validateSelectionIdentity(selection, request) {
  requireEvidence(
    isRecord(selection) &&
      selection.repository === request.repository &&
      selection.targetSha === request.targetSha &&
      selection.role === request.role &&
      typeof selection.runId === "string" &&
      positiveInteger(selection.runId) &&
      positiveInteger(selection.runAttempt) &&
      positiveInteger(selection.sourceParentRunId) &&
      positiveInteger(selection.sourceParentAttempt) &&
      positiveInteger(selection.artifact?.id) &&
      SHA.test(selection.workflowSha) &&
      typeof selection.workflowRef === "string" &&
      selection.workflowRef.length > 0 &&
      selection.displayTitle === `${request.spec.displayName} ${origin(selection, request)}` &&
      selection.url ===
        `https://github.com/${request.repository}/actions/runs/${selection.runId}` &&
      canonical(normalizedInputs(selection.inputs)) === canonical(request.inputs),
    "selection identity or dispatch inputs changed",
  );
}

async function validateEvidence(selection, request, deps) {
  validateSelectionIdentity(selection, request);
  const run = await deps.github(`actions/runs/${selection.runId}`);
  validateRun(run, selection, request);
  const lineage = await deps.github(`compare/${selection.workflowSha}...main?per_page=1`);
  requireEvidence(
    ["ahead", "identical"].includes(lineage?.status) &&
      lineage.merge_base_commit?.sha === selection.workflowSha,
    "workflow SHA is not a main ancestor",
  );
  const artifact = await deps.github(`actions/artifacts/${String(selection.artifact.id)}`);
  requireEvidence(
    canonical(artifactIdentity(artifact, request, run, deps.now)) === canonical(selection.artifact),
    "artifact identity changed after selection",
  );
  const downloaded = await deps.downloadArchive({
    deadlineMs: deps.deadlineMs,
    expected: {
      repository: request.repository,
      workflowSha: selection.workflowSha,
      runId: Number(selection.runId),
      artifactId: Number(selection.artifact.id),
      artifactName: selection.artifact.name,
      artifactDigest: selection.artifact.digest,
      artifactExpiresAt: selection.artifact.expiresAt,
      artifactSizeBytes: selection.artifact.sizeInBytes,
    },
    maxArchiveBytes: MAX_RELEASE_ARTIFACT_BYTES,
    token: deps.token,
  });
  requireEvidence(
    canonical(artifactIdentity(downloaded.artifactMetadata, request, run, deps.now)) ===
      canonical(selection.artifact),
    "downloaded artifact identity changed",
  );
  const archiveBytes = downloaded.archiveBytes;
  requireEvidence(
    archiveBytes instanceof Uint8Array &&
      archiveBytes.length === selection.artifact.sizeInBytes &&
      `sha256:${createHash("sha256").update(archiveBytes).digest("hex")}` ===
        selection.artifact.digest,
    "archive bytes differ from their digest",
  );
  const files = inspectActionsArtifactZip(archiveBytes, [RECEIPT_FILE], {
    maxArchiveBytes: MAX_RELEASE_ARTIFACT_BYTES,
    maxCompressedEntryBytes: MAX_RELEASE_ARTIFACT_BYTES,
    maxEntryBytes: MAX_RELEASE_ARTIFACT_BYTES,
    maxExpandedBytes: MAX_RELEASE_ARTIFACT_BYTES,
  });
  const receipt = JSON.parse(Buffer.from(files.get(RECEIPT_FILE)).toString("utf8"));
  const { sha256, ...payload } = receipt;
  requireEvidence(
    /^[a-f0-9]{64}$/u.test(sha256) &&
      createHash("sha256").update(canonical(payload)).digest("hex") === sha256 &&
      (selection.receiptSha256 === undefined || selection.receiptSha256 === sha256),
    "receipt digest changed",
  );
  requireEvidence(
    receipt.schema === "openclaw.full-release-child-evidence/v1" &&
      receipt.role === request.role &&
      receipt.targetSha === request.targetSha &&
      receipt.workflowSha === selection.workflowSha &&
      receipt.workflowRef === selection.workflowRef &&
      receipt.workflowPath === `.github/workflows/${request.spec.workflow}` &&
      receipt.displayTitle === selection.displayTitle &&
      receipt.dispatchId === origin(selection, request) &&
      receipt.sourceParentRunId === selection.sourceParentRunId &&
      receipt.sourceParentAttempt === selection.sourceParentAttempt &&
      receipt.workloadConclusion === "success" &&
      canonical(receipt.inputs) === canonical(request.inputs),
    "receipt target, origin, or exact dispatch inputs changed",
  );
  const attempts = [];
  for (let runAttempt = 1; runAttempt <= run.run_attempt; runAttempt += 1) {
    attempts.push({ runAttempt, jobs: await readAttemptJobs(deps.github, run, runAttempt) });
  }
  const jobs = attempts.at(-1).jobs;
  validatePublisher(jobs, receipt);
  const composite = composeReleaseChildAttemptEvidence({
    attempts,
    expected: expectedRun(selection, request),
    run,
  });
  composite.jobs = composite.jobs.filter((job) => job.name !== PUBLISHER_JOB);
  composite.compositeJobsSha256 = releaseCompositeJobsSha256(composite);
  requireEvidence(
    composite.jobs.length > 0 &&
      composite.jobs.every((job) => ["success", "neutral"].includes(job.conclusion)) &&
      Object.entries(composite).every(
        ([key, value]) => canonical(receipt[key]) === canonical(value),
      ),
    "receipt does not match the complete live composite workload",
  );
  const parent = await deps.github(
    `actions/runs/${selection.sourceParentRunId}/attempts/${selection.sourceParentAttempt}`,
  );
  requireEvidence(
    String(parent?.id) === selection.sourceParentRunId &&
      parent.run_attempt === selection.sourceParentAttempt &&
      parent.event === "workflow_dispatch" &&
      parent.head_sha === selection.workflowSha &&
      parent.head_branch === selection.workflowRef &&
      String(parent.path).split("@", 1)[0] === ".github/workflows/full-release-validation.yml" &&
      parent.repository?.full_name === request.repository &&
      parent.head_repository?.full_name === request.repository,
    "source parent origin is invalid",
  );
  // A rerun begun during verification invalidates the previously sealed attempt.
  const currentRun = await deps.github(`actions/runs/${selection.runId}`);
  validateRun(currentRun, selection, request);
  return { selection: { ...selection, receiptSha256: sha256 }, receipt, run: currentRun, jobs };
}

export async function validateReusableReleaseChild(selection, request, deps = {}) {
  const normalized = requestValue(request);
  requireEvidence(/^[a-f0-9]{64}$/u.test(selection?.receiptSha256), "selection omitted its digest");
  return validateEvidence(selection, normalized, dependencies(request.repository, deps));
}

export async function discoverReusableReleaseChild(request, deps = {}) {
  const normalized = requestValue(request);
  const resolved = dependencies(request.repository, deps);
  const inventory = await resolved.github(
    `actions/workflows/${normalized.spec.workflow}/runs?event=workflow_dispatch&per_page=${MAX_RUNS}`,
  );
  requireEvidence(Array.isArray(inventory?.workflow_runs), "run inventory is invalid");
  let evaluated = 0;
  for (const run of inventory.workflow_runs.slice(0, MAX_RUNS)) {
    if (run.status !== "completed" || run.conclusion !== "success") {
      continue;
    }
    const prefix = `${normalized.spec.displayName} full-release-validation-`;
    if (!String(run.display_title).startsWith(prefix)) {
      continue;
    }
    const parent = /^([1-9][0-9]*)-([1-9][0-9]*)(.*)$/u.exec(
      run.display_title.slice(prefix.length),
    );
    if (
      !parent ||
      parent[3] !== normalized.spec.suffix ||
      parent[1] === String(request.excludeRunId ?? "")
    ) {
      continue;
    }
    if (evaluated >= MAX_CANDIDATES) {
      break;
    }
    evaluated += 1;
    try {
      const name = artifactName(normalized, run.id, run.run_attempt);
      const artifacts = await resolved.github(
        `actions/runs/${run.id}/artifacts?name=${encodeURIComponent(name)}&per_page=100`,
      );
      requireEvidence(
        Array.isArray(artifacts?.artifacts) && artifacts.total_count === artifacts.artifacts.length,
        "artifact inventory is incomplete",
      );
      const matching = artifacts.artifacts.filter((artifact) => artifact.name === name);
      requireEvidence(matching.length === 1, "receipt artifact is absent or ambiguous");
      const selection = {
        repository: request.repository,
        targetSha: request.targetSha,
        role: request.role,
        runId: String(run.id),
        runAttempt: run.run_attempt,
        workflowSha: run.head_sha,
        workflowRef: run.head_branch,
        displayTitle: run.display_title,
        sourceParentRunId: parent[1],
        sourceParentAttempt: Number(parent[2]),
        url: `https://github.com/${request.repository}/actions/runs/${run.id}`,
        artifact: artifactIdentity(matching[0], normalized, run, resolved.now),
        inputs: normalized.inputs,
      };
      return (await validateEvidence(selection, normalized, resolved)).selection;
    } catch {
      // Reuse is optional. Invalid, missing, or unavailable evidence schedules
      // fresh work; immutable selections are revalidated strictly by consumers.
    }
  }
  return null;
}
