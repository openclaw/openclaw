#!/usr/bin/env node
// A new P-owned aggregate over original receipts, never a replacement historical plan.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { verifyRetainedPublicationArtifacts } from "./full-release-artifacts.mjs";
import {
  createPublicationAdmission,
  publicationObservationJson,
  publicationIntentInputs,
  publicationSourceRequest,
  validatePublicationAdmissionBinding,
  validatePublicationSourceBinding,
} from "./full-release-publication-contract.mjs";
import {
  releaseChildSpec,
  validateReleaseChildDispatchBinding,
} from "./full-release-validation-policy.mjs";
import {
  downloadExactActionsArtifactArchive,
  inspectActionsArtifactZip,
  verifyExactActionsArtifactDigest,
} from "./lib/actions-artifact-archive.mjs";
import {
  candidateArtifactJsonFromBinding,
  verifySealedFullReleaseCandidate,
} from "./lib/full-release-candidate-reuse.mjs";
import { releaseChildDispatchInputs } from "./lib/full-release-child-request.mjs";
import { validateReusableReleaseChild } from "./lib/full-release-child-reuse.mjs";
import { manifestContextFromEnvironment } from "./lib/full-release-manifest.mjs";
import { validateQualificationBaselinePolicy } from "./lib/qualification-admission-baselines.mjs";
import {
  PREPARED_NPM_MANIFEST,
  validatePreparedNpmRelease,
} from "./plugin-npm-prepared-release.mjs";
import {
  revalidateQualificationAdmissionAuthority,
  verifyReleaseQualificationOperator,
} from "./release-qualification-admission.mjs";
import { validateQualificationJobs } from "./release-qualification-coverage.mjs";
import {
  runReleaseToolingGh,
  verifyReleaseToolingIdentity,
  verifyReleaseWorkflowRun,
} from "./release-tooling-identity.mjs";

export const RECEIPT_RECOVERY_WORKFLOW = ".github/workflows/full-release-receipt-recovery.yml";
export const RECEIPT_RECOVERY_SCHEMA = "openclaw.full-release-receipt-recovery/v1";
const ROLES = [
  "normalCi",
  "pluginPrereleaseIndependent",
  "releaseChecksIndependent",
  "releaseChecksCandidate",
  "pluginPrereleaseCandidate",
];
const JOB = "Recover original qualification receipts";
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
function requireValue(condition, message) {
  if (!condition) {
    throw new Error("Receipt recovery: " + message);
  }
}
function same(left, right, message) {
  requireValue(isDeepStrictEqual(left, right), message);
}
function json(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}
function api(repository, path) {
  return JSON.parse(runReleaseToolingGh(["api", "repos/" + repository + "/" + path]));
}

export function validateReceiptRecoveryRequest(request) {
  same(
    Object.keys(request ?? {}).toSorted(),
    [
      "schema",
      "requestId",
      "repository",
      "qualificationAdmission",
      "originalParent",
      "candidateBinding",
      "children",
      "publicationArtifacts",
    ].toSorted(),
    "unexpected request fields",
  );
  requireValue(
    request.schema === RECEIPT_RECOVERY_SCHEMA && request.repository === "openclaw/openclaw",
    "unsupported recovery request",
  );
  requireValue(
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(
      request.requestId,
    ),
    "a new recovery request UUID is required",
  );
  same(
    Object.keys(request.originalParent ?? {}).toSorted(),
    ["runAttempt", "runId"],
    "invalid original parent tuple",
  );
  requireValue(
    /^[1-9][0-9]*$/u.test(request.originalParent.runId) && request.originalParent.runAttempt === 1,
    "original parent must identify its first attempt",
  );
  same(
    Object.keys(request.children ?? {}).toSorted(),
    ROLES.toSorted(),
    "recovery requires exactly the five complete beta roles",
  );
  requireValue(
    Buffer.byteLength(JSON.stringify(request)) <= 128 * 1024,
    "request exceeds byte limit",
  );
  return request;
}

// Derive operands from the independently admitted request, not caller-supplied
// receipt.inputs. The immutable Q workflow supplies all unsupplied defaults.
export function receiptRecoveryChildInputs(role, admission, binding, workflowSource) {
  const input = admission.request.inputs;
  const lane = JSON.parse(input.trusted_workflow_json).laneInputs ?? {};
  const target = admission.request.candidateSha;
  const context = input.target_context_ref || "";
  const args = [];
  const add = (key, value) => args.push("-f", key + "=" + String(value));
  const optional = (key, value) => {
    if (value) {
      add(key, value);
    }
  };
  if (role === "normalCi") {
    add("target_ref", target);
    add("release_scope", "npm-beta");
    add("include_android", false);
    const ref = (context || input.ref).replace(/^refs\/(?:heads|tags)\//u, "");
    if (/^v[0-9]{4}\.[0-9]+\.[0-9]+(?:-beta\.[0-9]+)?$/u.test(ref)) {
      add("historical_target_tag", ref);
    } else if (/^release\/[0-9]{4}\.[0-9]+\.[0-9]+$/u.test(ref)) {
      add("target_context_ref", ref);
    }
  } else {
    const phase = role.endsWith("Independent") ? "independent" : "candidate";
    if (role.startsWith("pluginPrerelease")) {
      add("target_ref", target);
      add("expected_sha", target);
      add("full_release_validation", true);
      add("phase", phase);
      add("node_test_exclude_patterns_json", input.plugin_prerelease_node_exclude_patterns_json);
      add(
        "extension_test_exclude_patterns_json",
        lane.extension_test_exclude_patterns_json ?? "[]",
      );
    } else {
      add("ref", target);
      add("expected_sha", target);
      add("provider", input.provider);
      add("mode", input.mode);
      add("release_profile", "beta");
      add("run_release_soak", false);
      add("fail_fast", input.fail_fast);
      add("phase", phase);
      add("allow_unreleased_changelog", input.allow_unreleased_changelog);
      add("skip_package_telegram_e2e", true);
      add("rerun_group", "all");
      for (const key of [
        "live_suite_filter",
        "cross_os_suite_filter",
        "release_package_spec",
        "package_acceptance_package_spec",
        "codex_plugin_spec",
      ]) {
        optional(key, input[key]);
      }
    }
    optional("target_context_ref", context);
    if (phase === "candidate") {
      add("candidate_artifact_json", candidateArtifactJsonFromBinding(binding));
    }
  }
  optional("qualification_baselines_json", lane.qualification_baselines_json);
  return releaseChildDispatchInputs(workflowSource, args);
}

export function receiptRecoverySourceRequest(admission, producer) {
  const original = admission.request;
  const request = publicationSourceRequest({
    PUBLICATION_INPUTS_JSON: JSON.stringify(original.inputs),
    PUBLICATION_TOOLING_JSON: JSON.stringify({
      ref: original.transportRef,
      fullRef: "refs/heads/" + original.transportRef,
      sha: original.qualificationSha,
    }),
    GITHUB_REPOSITORY: original.repository,
    PUBLICATION_TARGET_SHA: original.candidateSha,
    PUBLICATION_TARGET_CONTEXT: original.inputs.target_context_ref || original.inputs.ref,
    PUBLICATION_SKIP_TELEGRAM: "true",
    PUBLICATION_COVERAGE_POLICY: "npm-beta-v1",
    GITHUB_REF: "refs/heads/" + original.transportRef,
    GITHUB_SHA: original.qualificationSha,
    GITHUB_RUN_ID: producer.runId,
    GITHUB_RUN_ATTEMPT: String(producer.runAttempt),
  });
  // The new source admission owns current registry observations. Original
  // qualification admission remains separate, immutable evidence below.
  delete request.qualificationAdmission;
  delete request.qualificationInputs;
  request.tooling = { ref: producer.fullRef, sha: producer.sha };
  request.workflow = { ...request.tooling };
  return request;
}

function producerFromManifest(manifest) {
  return {
    runId: String(manifest.runId),
    runAttempt: Number(manifest.runAttempt),
    fullRef: manifest.workflowFullRef,
    sha: manifest.workflowSha,
  };
}

export function verifyReceiptRecoveryAuthority(repository, producer, completed = true) {
  requireValue(producer.fullRef === "refs/heads/main", "recovery must execute trusted P on main");
  verifyReleaseToolingIdentity({
    repository,
    workflowRef: "main",
    workflowFullRef: producer.fullRef,
    workflowSha: producer.sha,
  });
  const run = verifyReleaseWorkflowRun({
    repository,
    workflowRef: "main",
    workflowFullRef: producer.fullRef,
    workflowSha: producer.sha,
    runId: producer.runId,
    runAttempt: String(producer.runAttempt),
    workflowPath: RECEIPT_RECOVERY_WORKFLOW,
    workflowEvent: "workflow_dispatch",
    runStatePolicy: completed ? "success" : "active",
  });
  verifyReleaseQualificationOperator(repository, run.actor, runReleaseToolingGh);
  verifyReleaseQualificationOperator(repository, run.triggering_actor, runReleaseToolingGh);
  return run;
}

async function downloadPayload(repository, artifact, workflowSha, deps, digestOnly = false) {
  const metadata = await deps.client.getArtifact(artifact.id);
  const transfer = digestOnly
    ? verifyExactActionsArtifactDigest
    : downloadExactActionsArtifactArchive;
  const downloaded = await transfer({
    expected: {
      repository,
      runId: Number(artifact.runId),
      workflowSha,
      artifactId: Number(artifact.id),
      artifactName: artifact.name,
      artifactDigest: "sha256:" + artifact.digest.replace(/^sha256:/u, ""),
      artifactExpiresAt: artifact.expiresAt ?? metadata.expires_at,
      artifactSizeBytes: metadata.size_in_bytes,
    },
    token: deps.token,
  });
  return digestOnly ? downloaded.digest : downloaded.archiveBytes;
}

export async function verifyOriginalReceiptQualification(requestValue, dependencies = {}) {
  const request = validateReceiptRecoveryRequest(requestValue);
  const { createReleaseEvidenceClient } = await import("./release-ci-summary.mjs");
  const client = dependencies.client ?? createReleaseEvidenceClient(request.repository);
  const deps = { client, token: process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN };
  const binding = request.candidateBinding;
  const target = binding?.request?.targetSha;
  const qualificationSha = binding?.request?.toolingSha;
  requireValue(
    target === qualificationSha && /^[a-f0-9]{40}$/u.test(target),
    "original candidate must retain C=Q",
  );
  const parent = await client.getRunAttempt(
    request.originalParent.runId,
    request.originalParent.runAttempt,
  );
  const admission = await client.verifyQualificationAdmission({
    descriptor: request.qualificationAdmission,
    repository: request.repository,
    candidateSha: target,
    qualificationSha,
    workflowRef: parent.head_branch,
  });
  requireValue(
    admission.request.requestId !== request.requestId,
    "recovery must not reuse the qualification request identity",
  );
  requireValue(
    admission.request.inputs.release_profile === "beta" &&
      admission.request.inputs.rerun_group === "all" &&
      admission.request.inputs.mode === "both",
    "only full beta qualification can be recovered",
  );
  const baselines = validateQualificationBaselinePolicy(
    admission.request,
    admission.baselinePolicy,
  );
  requireValue(
    binding.package.version === admission.baselinePolicy.candidateVersion &&
      binding.request.releaseProfile === "beta" &&
      binding.request.releaseSoak === false,
    "candidate profile or version differs from original admission",
  );
  same(
    binding.request.upgradeSurvivorBaselines,
    baselines.upgradeSurvivorBaselines,
    "candidate survivor baselines changed",
  );
  if (binding.request.upgradeBaseline !== undefined) {
    same(
      binding.request.upgradeBaseline,
      baselines.upgradeBaseline,
      "candidate upgrade baseline changed",
    );
  }
  same(
    admission.coverage.children.map((child) => child.key).toSorted(),
    ROLES.toSorted(),
    "original admission must cover every beta role",
  );
  requireValue(
    parent.head_sha === target &&
      parent.head_branch === admission.request.transportRef &&
      parent.event === "workflow_dispatch" &&
      String(parent.path).split("@")[0] === ".github/workflows/full-release-validation.yml" &&
      parent.repository?.full_name === request.repository &&
      parent.head_repository?.full_name === request.repository,
    "original parent differs from admitted C/Q transport",
  );
  const parentJobs = await client.getRunAttemptJobs(request.originalParent.runId, 1, {
    requireComplete: true,
  });
  validateQualificationJobs(
    parentJobs,
    admission.coverage.requiredParentJobs,
    "Original qualification parent",
  );
  await verifySealedFullReleaseCandidate({
    binding,
    consumerRunId: request.originalParent.runId,
    consumerRunAttempt: "1",
    readArtifact: (id) => client.getArtifact(id),
    readRunAttempt: (id, attempt) => client.getRunAttempt(id, attempt),
    readWorkflowJobs: async (id, attempt) => {
      const jobs = await client.getRunAttemptJobs(id, attempt, { requireComplete: true });
      return { total_count: jobs.length, jobs };
    },
    token: deps.token,
  });
  // The five fixed roles are independent reads. Share the existing four-process
  // GitHub budget instead of serializing whole histories; settle every reader
  // before returning a failure, and retain the original role order.
  const childResults = await Promise.allSettled(
    ROLES.map(async (role) => {
      const selection = request.children[role];
      requireValue(
        selection.sourceParentRunId === request.originalParent.runId &&
          selection.sourceParentAttempt === 1 &&
          selection.workflowRef === admission.request.transportRef,
        "child does not belong to the original parent",
      );
      const spec = releaseChildSpec(role);
      const source = client.getWorkflowSource(
        qualificationSha,
        ".github/workflows/" + spec.workflow,
      );
      const inputs = receiptRecoveryChildInputs(role, admission, binding, source);
      const verified = await validateReusableReleaseChild(
        selection,
        {
          repository: request.repository,
          targetSha: target,
          workflowSha: qualificationSha,
          role,
          inputs,
        },
        // Recovery must enumerate every historical attempt, including long rerun chains.
        { token: deps.token, deadlineMs: Date.now() + 10 * 60_000 },
      );
      const coverage = admission.coverage.children.find((child) => child.key === role);
      validateQualificationJobs(verified.receipt.jobs, coverage.requiredJobs, "Original " + role);
      const dispatchJobs = parentJobs.filter((job) => job.name === coverage.parentJobName);
      requireValue(
        dispatchJobs.length === 1 &&
          dispatchJobs[0].status === "completed" &&
          dispatchJobs[0].conclusion === "success",
        "original dispatch did not succeed exactly once",
      );
      validateReleaseChildDispatchBinding({
        child: { key: role, runId: selection.runId },
        log: await client.getJobLog(dispatchJobs[0].id),
        coveragePolicy: "npm-beta-v1",
        plannedRunAttempt: 1,
        repository: request.repository,
        targetSha: target,
      });
      return {
        role,
        runId: selection.runId,
        runAttempt: selection.runAttempt,
        workflowSha: qualificationSha,
        sourceParentRunId: request.originalParent.runId,
        conclusion: "success",
        receipt: verified.receipt,
      };
    }),
  );
  const children = childResults.map((result) => {
    if (result.status === "rejected") {
      throw result.reason;
    }
    return result.value;
  });
  const originalRoot = {
    workflowName: "Full Release Validation",
    runId: request.originalParent.runId,
    runAttempt: 1,
    sourceParentRunAttempt: 1,
    workflowRef: parent.head_branch,
    workflowFullRef: "refs/heads/" + parent.head_branch,
    workflowSha: qualificationSha,
    targetSha: target,
    publicationArtifacts: request.publicationArtifacts,
  };
  const publication = await verifyRetainedPublicationArtifacts(
    originalRoot,
    {
      GITHUB_REPOSITORY: request.repository,
      TARGET_SHA: target,
      PARENT_WORKFLOW_SHA: qualificationSha,
      RELEASE_TAG: "v" + binding.package.version,
      PLUGIN_NPM_REQUIRED: "true",
    },
    {
      verifyPayloads: true,
      // Large Docker bodies may need the full transfer budget; metadata stays capped at 60s.
      dockerArchiveTimeoutMs: 4 * 60_000,
      expectedPackage: {
        fileName: binding.package.fileName,
        sha256: binding.package.packageSha256,
      },
    },
  );
  const plugin = request.publicationArtifacts.pluginNpm;
  const pluginArtifact = {
    id: plugin.artifactId,
    name: plugin.artifactName,
    runId: plugin.runId,
    digest: plugin.artifactDigest,
  };
  const pluginFiles = inspectActionsArtifactZip(
    await downloadPayload(request.repository, pluginArtifact, qualificationSha, deps),
    [PREPARED_NPM_MANIFEST],
  );
  const selection = JSON.parse(admission.request.inputs.trusted_workflow_json).publicationSelection;
  const preparedPlugins = validatePreparedNpmRelease(
    JSON.parse(pluginFiles.get(PREPARED_NPM_MANIFEST).toString("utf8")),
    {
      repository: request.repository,
      sourceSha: target,
      workflowSha: qualificationSha,
      npmDistTag: "default",
      selectionMode: selection.pluginPublishScope,
      plugins: selection.plugins.join(","),
      publisherPolicySha256: sha(client.getWorkflowSource(qualificationSha, plugin.workflowPath)),
    },
  );
  for (const entry of preparedPlugins.packages) {
    const bytes = await downloadPayload(
      request.repository,
      {
        id: entry.artifact.artifactId,
        name: entry.artifact.artifactName,
        runId: entry.artifact.runId,
        digest: entry.artifact.artifactDigest,
      },
      qualificationSha,
      deps,
    );
    publication.payloads.push({
      kind: "plugin-npm-package",
      artifact: entry.artifact,
      sha256: sha(bytes),
    });
  }
  for (const [kind, constituent] of [
    ["candidate-shared-image", binding.sharedImage],
    ["candidate-plugin-registry", binding.prepublishPluginRegistry],
  ]) {
    const digest = await downloadPayload(
      request.repository,
      constituent.artifact,
      qualificationSha,
      deps,
      true,
    );
    publication.payloads.push({
      kind,
      artifact: constituent.artifact,
      sha256: digest.slice("sha256:".length),
    });
  }
  // The independently produced candidate package must contain the same tgz as
  // the original qualified npm bundle, not merely an identically named package.
  const packageBytes = await downloadPayload(
    request.repository,
    binding.package.artifact,
    qualificationSha,
    deps,
  );
  const files = inspectActionsArtifactZip(
    packageBytes,
    [binding.package.fileName, "package-candidate.json"],
    {
      maxArchiveBytes: 256 * 1024 * 1024,
      maxCompressedEntryBytes: 256 * 1024 * 1024,
      maxEntryBytes: 256 * 1024 * 1024,
      maxExpandedBytes: 256 * 1024 * 1024,
    },
  );
  requireValue(
    sha(files.get(binding.package.fileName)) === binding.package.packageSha256,
    "candidate package bytes differ from the qualified original",
  );
  await revalidateReceiptRecoveryRuns(request, client);
  revalidateQualificationAdmissionAuthority({
    descriptor: request.qualificationAdmission,
    admission,
  });
  return { admission, children, originalRoot, publication };
}

export async function revalidateReceiptRecoveryRuns(request, client) {
  const tuples = [
    ...ROLES.map((role) => request.children[role]),
    request.candidateBinding.producer,
    request.publicationArtifacts.npmPreflight.producer,
    {
      runId: request.publicationArtifacts.docker.preparedRunId,
      runAttempt: request.publicationArtifacts.docker.preparedRunAttempt,
    },
    request.publicationArtifacts.pluginNpm,
  ];
  for (const tuple of tuples) {
    const current = await client.getRun(String(tuple.runId));
    requireValue(
      String(current.id) === String(tuple.runId) &&
        Number(current.run_attempt) === Number(tuple.runAttempt) &&
        current.head_sha === request.candidateBinding.request.toolingSha &&
        current.status === "completed" &&
        current.conclusion === "success",
      "original producer or child current attempt changed: " + tuple.runId,
    );
  }
}

function successfulStep(job, name) {
  const matches = job.steps?.filter((step) => step.name === name) ?? [];
  requireValue(
    matches.length === 1 &&
      matches[0].status === "completed" &&
      matches[0].conclusion === "success",
    "missing successful " + name,
  );
  return matches[0];
}

export async function authenticateReceiptRecovery({
  manifest,
  artifact,
  run,
  client,
  verifier,
  expectedRunAttempts,
}) {
  const request = validateReceiptRecoveryRequest(manifest.receiptRecovery);
  const producer = producerFromManifest(manifest);
  verifyReceiptRecoveryAuthority(request.repository, producer);
  const workflow = client.getWorkflowSource(producer.sha, RECEIPT_RECOVERY_WORKFLOW);
  requireValue(
    /^ {2}FULL_RELEASE_RECEIPT_RECOVERY_CONTRACT: "1"$/mu.test(workflow),
    "missing immutable recovery contract",
  );
  requireValue(
    run.name === "Full Release Receipt Recovery" &&
      run.id === Number(producer.runId) &&
      run.run_attempt === producer.runAttempt &&
      run.head_sha === producer.sha &&
      String(run.path).split("@")[0] === RECEIPT_RECOVERY_WORKFLOW,
    "aggregate run identity differs",
  );
  same(
    manifest.targetSha,
    request.candidateBinding.request.targetSha,
    "aggregate changed the original candidate",
  );
  requireValue(
    manifest.version === 4 &&
      manifest.workflowName === "Full Release Validation" &&
      manifest.workflowRef === "main" &&
      manifest.workflowFullRef === "refs/heads/main" &&
      manifest.workflowRefType === "branch" &&
      manifest.targetRef === manifest.targetSha &&
      manifest.releaseProfile === "beta" &&
      manifest.rerunGroup === "all" &&
      manifest.runReleaseSoak === "false" &&
      manifest.sourceParentRunAttempt === producer.runAttempt &&
      !manifest.evidenceReuse &&
      !manifest.executionPlanSha256 &&
      !manifest.qualificationCoverage &&
      !manifest.sourceAdmission?.qualificationAdmission &&
      !manifest.candidateBinding,
    "aggregate must not impersonate historical qualification",
  );
  same(manifest.waivers, [], "aggregate cannot add runtime waivers");
  same(manifest.advisoryJobs, [], "aggregate cannot hide jobs as advisory");
  same(
    manifest.controls,
    {
      stableSoakRequired: false,
      performanceBlocking: false,
      performanceReportPublication: "artifact-only",
    },
    "aggregate controls changed",
  );
  same(
    manifest.publicationArtifacts,
    request.publicationArtifacts,
    "aggregate changed retained publication artifacts",
  );
  same(
    manifest.childRuns,
    Object.fromEntries(ROLES.map((role) => [role, request.children[role].runId])),
    "aggregate changed original children",
  );
  const verified = await verifyOriginalReceiptQualification(request, { client });
  same(
    manifest.retainedPublicationPayloads,
    verified.publication.payloads,
    "original publication payload inventory changed",
  );
  const expectedSource = receiptRecoverySourceRequest(verified.admission, producer);
  const source = validatePublicationSourceBinding(manifest);
  requireValue(
    source.projection.version === verified.admission.baselinePolicy.candidateVersion,
    "fresh publication source changed the candidate version",
  );
  for (const [key, value] of Object.entries(expectedSource)) {
    same(source[key], value, "fresh source changed original " + key);
  }
  const admission = validatePublicationAdmissionBinding(manifest, {
    workflowPath: RECEIPT_RECOVERY_WORKFLOW,
  });
  const jobs = await client.getRunAttemptJobs(producer.runId, producer.runAttempt, {
    requireComplete: true,
  });
  const sealers = jobs.filter((job) => job.name === JOB);
  requireValue(
    sealers.length === 1 &&
      sealers[0].status === "completed" &&
      sealers[0].conclusion === "success",
    "aggregate job did not succeed",
  );
  const sealer = sealers[0];
  const observe = successfulStep(
    sealer,
    "Authenticate retained qualification and collect fresh admission",
  );
  const upload = successfulStep(sealer, "Upload fresh publication observations");
  const seal = successfulStep(sealer, "Seal receipt-backed aggregate");
  const aggregateUpload = successfulStep(sealer, "Upload receipt-backed aggregate");
  requireValue(
    observe.number < upload.number &&
      upload.number < seal.number &&
      seal.number < aggregateUpload.number,
    "aggregate admission ordering changed",
  );
  const observationArtifact = await client.getArtifact(admission.binding.artifact.id);
  const created = Date.parse(observationArtifact.created_at);
  requireValue(
    created >= Date.parse(upload.started_at) &&
      created <= Date.parse(upload.completed_at) &&
      Date.parse(admission.binding.admittedAt) >= Date.parse(seal.started_at) &&
      Date.parse(admission.binding.admittedAt) <= Date.parse(seal.completed_at) + 1000 &&
      Date.parse(artifact.created_at) >= Date.parse(aggregateUpload.started_at) &&
      Date.parse(artifact.created_at) <= Date.parse(aggregateUpload.completed_at),
    "new admission was not recorded in this aggregate attempt",
  );
  const observationBytes = await downloadPayload(
    request.repository,
    {
      id: observationArtifact.id,
      name: observationArtifact.name,
      runId: producer.runId,
      digest: observationArtifact.digest,
    },
    producer.sha,
    { client, token: process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN },
  );
  const observedFiles = inspectActionsArtifactZip(observationBytes, [
    "publication-observations.json",
  ]);
  same(
    JSON.parse(Buffer.from(observedFiles.get("publication-observations.json")).toString("utf8")),
    admission.observations,
    "fresh observation artifact bytes differ",
  );
  same(
    {
      id: String(observationArtifact.id),
      name: observationArtifact.name,
      digest: observationArtifact.digest,
      sizeInBytes: observationArtifact.size_in_bytes,
    },
    admission.binding.artifact,
    "fresh observation artifact identity differs",
  );
  if (expectedRunAttempts) {
    for (const [id, attempt] of [
      [producer.runId, producer.runAttempt],
      ...ROLES.map((role) => [request.children[role].runId, request.children[role].runAttempt]),
    ]) {
      same(expectedRunAttempts.get(id), attempt, "expected attempt changed: " + id);
      expectedRunAttempts.delete(id);
    }
    requireValue(expectedRunAttempts.size === 0, "unexpected run-attempt constraints");
  }
  await revalidateReceiptRecoveryRuns(request, client);
  revalidateQualificationAdmissionAuthority({
    descriptor: request.qualificationAdmission,
    admission: verified.admission,
  });
  verifyReceiptRecoveryAuthority(request.repository, producer);
  const current = {
    artifact: {
      id: String(artifact.id),
      name: artifact.name,
      digest: artifact.digest,
      sizeInBytes: Number(artifact.size_in_bytes),
      runAttempt: producer.runAttempt,
    },
    conclusion: "success",
    manifest,
    manifestVersion: 4,
    runAttempt: producer.runAttempt,
    runId: producer.runId,
    status: "completed",
    targetSha: manifest.targetSha,
    url: run.html_url,
    workflowPath: RECEIPT_RECOVERY_WORKFLOW,
    workflowRef: "main",
    workflowFullRef: producer.fullRef,
    workflowSha: producer.sha,
    workflowRefProof: "receipt-backed-recovery-v1",
  };
  return {
    schema: "openclaw.release-validation-evidence/v4",
    valid: true,
    current,
    root: current,
    manifest: current.manifest,
    children: verified.children,
    waivers: [],
    conclusions: {
      current: "success",
      root: "success",
      children: Object.fromEntries(ROLES.map((role) => [role, "success"])),
    },
    controls: manifest.controls,
    directRoot: true,
    evidenceReuse: null,
    executionPlan: null,
    releaseProfile: "beta",
    rerunGroup: "all",
    runReleaseSoak: false,
    repository: request.repository,
    qualificationAdmission: verified.admission,
    producerOnTrustedMainLineage: true,
    verifier,
    validationInputs: manifest.validationInputs,
  };
}

async function main() {
  const env = process.env;
  const directory = join(env.RUNNER_TEMP, "receipt-recovery");
  const producer = {
    runId: env.GITHUB_RUN_ID,
    runAttempt: Number(env.GITHUB_RUN_ATTEMPT),
    fullRef: env.GITHUB_REF,
    sha: env.GITHUB_SHA,
  };
  const request = validateReceiptRecoveryRequest(JSON.parse(env.RECEIPT_RECOVERY_REQUEST));
  verifyReceiptRecoveryAuthority(request.repository, producer, false);
  mkdirSync(directory, { recursive: true });
  if (process.argv[2] === "admit") {
    const verified = await verifyOriginalReceiptQualification(request);
    writeFileSync(
      join(directory, "verified-payloads.json"),
      JSON.stringify(verified.publication.payloads),
    );
    const source = receiptRecoverySourceRequest(verified.admission, producer);
    writeFileSync(join(directory, "source-request.json"), JSON.stringify(source));
    const result = execFileSync(
      process.execPath,
      [
        "--import",
        fileURLToPath(new URL("./tsx.mjs", import.meta.url)),
        fileURLToPath(new URL("./full-release-publication-admission.mts", import.meta.url)),
        join(directory, "source-request.json"),
        "--observations-out",
        join(directory, "publication-observations.json"),
      ],
      {
        env: { ...env, PUBLICATION_TARGET_ROOT: env.GITHUB_WORKSPACE },
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
      },
    );
    writeFileSync(join(directory, "source.json"), result);
    revalidateQualificationAdmissionAuthority({
      descriptor: request.qualificationAdmission,
      admission: verified.admission,
    });
    verifyReceiptRecoveryAuthority(request.repository, producer, false);
  } else if (process.argv[2] === "seal") {
    const source = json(join(directory, "source.json"));
    const observations = json(join(directory, "publication-observations.json"));
    const observed = api(request.repository, "actions/artifacts/" + env.OBSERVATIONS_ARTIFACT_ID);
    const artifact = {
      id: String(observed.id),
      name: observed.name,
      digest: observed.digest,
      sizeInBytes: observed.size_in_bytes,
    };
    requireValue(
      observed.digest === "sha256:" + env.OBSERVATIONS_ARTIFACT_DIGEST.replace(/^sha256:/u, "") &&
        String(observed.workflow_run?.id) === producer.runId &&
        observed.workflow_run.head_sha === producer.sha,
      "new observation upload changed",
    );
    const context = manifestContextFromEnvironment(source, {
      GITHUB_RUN_ID: producer.runId,
      GITHUB_RUN_ATTEMPT: String(producer.runAttempt),
      GITHUB_REF_NAME: "main",
      GITHUB_SHA: producer.sha,
      GITHUB_REF: producer.fullRef,
      GITHUB_REF_TYPE: "branch",
      TARGET_REF: request.candidateBinding.request.targetSha,
    });
    context.validationInputs = {
      ...context.validationInputs,
      ...publicationIntentInputs(source),
      coveragePolicy: source.coverage.coverage_policy,
    };
    const manifest = {
      version: 4,
      ...context,
      workflowName: "Full Release Validation",
      targetSha: request.candidateBinding.request.targetSha,
      sourceParentRunAttempt: producer.runAttempt,
      sourceAdmissionContract: "1",
      sourceAdmission: source,
      trustedWorkflow: { ref: "main", fullRef: producer.fullRef, sha: producer.sha },
      publicationAdmissionContract: "1",
      publicationAdmission: createPublicationAdmission(
        source,
        observations,
        artifact,
        new Date().toISOString(),
        { workflowPath: RECEIPT_RECOVERY_WORKFLOW },
      ),
      publicationArtifacts: request.publicationArtifacts,
      receiptRecovery: request,
      retainedPublicationPayloads: json(join(directory, "verified-payloads.json")),
      waivers: [],
      advisoryJobs: [],
      controls: {
        stableSoakRequired: false,
        performanceBlocking: false,
        performanceReportPublication: "artifact-only",
      },
      childRuns: Object.fromEntries(ROLES.map((role) => [role, request.children[role].runId])),
    };
    const { createReleaseEvidenceClient } = await import("./release-ci-summary.mjs");
    const client = createReleaseEvidenceClient(request.repository);
    await revalidateReceiptRecoveryRuns(request, client);
    client.verifyQualificationAdmission({
      descriptor: request.qualificationAdmission,
      repository: request.repository,
      candidateSha: manifest.targetSha,
      qualificationSha: manifest.targetSha,
      workflowRef: request.children.normalCi.workflowRef,
    });
    verifyReceiptRecoveryAuthority(request.repository, producer, false);
    writeFileSync(
      join(directory, "full-release-validation-manifest.json"),
      publicationObservationJson(manifest),
    );
    appendFileSync(
      env.GITHUB_OUTPUT,
      "artifact_name=full-release-validation-" + producer.runId + "-" + producer.runAttempt + "\n",
    );
  } else {
    throw new Error("Expected admit or seal");
  }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
