#!/usr/bin/env node
// A new P-owned aggregate over original receipts, never a replacement historical plan.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
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
  qualificationChildDispatchInputs,
  resolveAdmittedQualificationScope,
  terminalPolicyPass,
  validateReleaseChildDispatchBinding,
} from "./full-release-validation-policy.mjs";
import {
  inspectActionsArtifactZip,
  validateArtifactMetadata,
  verifyExactActionsArtifactDigest,
} from "./lib/actions-artifact-archive.mjs";
import { verifySealedFullReleaseCandidate } from "./lib/full-release-candidate-reuse.mjs";
import { manifestContextFromEnvironment } from "./lib/full-release-manifest.mjs";
import { validateQualificationBaselinePolicy } from "./lib/qualification-admission-baselines.mjs";
import {
  RECEIPT_RECOVERY_WORKFLOW,
  verifyReceiptRecoveryAuthority,
} from "./lib/release-evidence-identity.mjs";
import {
  RELEASE_VALIDATION_WAIVERS_PATH,
  evaluateReleaseChildPolicy,
  readReleaseValidationWaiversAsync,
  releaseChildAdvisories,
  releaseWaiverEvidenceMatches,
} from "./lib/release-validation-waivers.mjs";
import {
  PREPARED_NPM_MANIFEST,
  validatePreparedNpmRelease,
} from "./plugin-npm-prepared-release.mjs";
import {
  createReleaseEvidenceClient,
  restoreOriginalPublicationAdmission,
  validatePerformanceArtifactOnlyJobs,
} from "./release-ci-summary.mjs";
import {
  buildQualificationAdmissionRequest,
  revalidateQualificationAdmissionAuthority,
} from "./release-qualification-admission.mjs";
import { validateQualificationJobs } from "./release-qualification-coverage.mjs";
import { runReleaseToolingGh } from "./release-tooling-identity.mjs";
export const RECEIPT_RECOVERY_SCHEMA = "openclaw.full-release-receipt-recovery/v1";
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
      ...(request?.workflowSha === undefined ? [] : ["workflowSha"]),
      ...(request?.policyQualification === undefined ? [] : ["policyQualification"]),
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
    [
      "runAttempt",
      "runId",
      ...(request.originalParent?.currentRunAttempt === undefined ? [] : ["currentRunAttempt"]),
    ].toSorted(),
    "invalid original parent tuple",
  );
  requireValue(
    /^[1-9][0-9]*$/u.test(request.originalParent.runId) && request.originalParent.runAttempt === 1,
    "original parent must identify its first attempt",
  );
  requireValue(
    request.originalParent.currentRunAttempt === undefined ||
      (Number.isSafeInteger(request.originalParent.currentRunAttempt) &&
        request.originalParent.currentRunAttempt >= request.originalParent.runAttempt),
    "invalid current parent attempt",
  );
  requireValue(
    request.children &&
      typeof request.children === "object" &&
      !Array.isArray(request.children) &&
      Object.keys(request.children).length > 0 &&
      Object.keys(request.children).length <= 32,
    "recovery requires original child receipts",
  );
  if (request.workflowSha !== undefined) {
    requireValue(/^[a-f0-9]{40}$/u.test(request.workflowSha), "invalid pinned recovery P");
  }
  if (request.policyQualification !== undefined) {
    same(
      Object.keys(request.policyQualification ?? {}).toSorted(),
      ["admission", "sha"],
      "invalid policy qualification",
    );
    requireValue(
      request.workflowSha &&
        /^[a-f0-9]{40}$/u.test(request.policyQualification.sha) &&
        request.policyQualification.admission,
      "policy qualification requires a pinned SHA, admission and recovery P",
    );
  }
  requireValue(
    Buffer.byteLength(JSON.stringify(request)) <= 128 * 1024,
    "request exceeds byte limit",
  );
  return request;
}

export async function verifyWaiverPolicyCommit(client, originalSha, policySha) {
  const commit = await client.getCommit(policySha);
  requireValue(
    commit?.sha === policySha &&
      commit.parents?.length === 1 &&
      commit.parents[0]?.sha === originalSha &&
      commit.commit?.verification?.verified === true &&
      commit.files?.length === 1 &&
      commit.files[0]?.status === "modified" &&
      commit.files[0]?.filename === RELEASE_VALIDATION_WAIVERS_PATH,
    "policy Q must be a verified signed direct child of original Q modifying only the waiver ledger",
  );
}

export function receiptRecoveryPolicyRequest(original, policySha, requestId) {
  const { repository, candidateSha, qualificationSha, inputs } = original.request;
  const transportRef = original.request.transportRef.replace(
    "release-ci/" + qualificationSha.slice(0, 12) + "-",
    "release-ci/" + policySha.slice(0, 12) + "-",
  );
  const envelope = JSON.parse(inputs.trusted_workflow_json);
  envelope.trustedWorkflow = {
    ref: transportRef,
    fullRef: "refs/heads/" + transportRef,
    sha: policySha,
  };
  return buildQualificationAdmissionRequest({
    repository,
    candidateSha,
    qualificationSha: policySha,
    requestId,
    transportRef,
    reviewed: true,
    inputs: { ...inputs, trusted_workflow_json: JSON.stringify(envelope) },
  });
}

export async function verifyReceiptRecoveryPolicy(request, original, client) {
  const policy = request.policyQualification;
  if (!policy) {
    return undefined;
  }
  const { candidateSha, qualificationSha, repository } = original.request;
  await verifyWaiverPolicyCommit(client, qualificationSha, policy.sha);
  const workflowRef = receiptRecoveryPolicyRequest(
    original,
    policy.sha,
    request.requestId,
  ).transportRef;
  const admission = await client.verifyQualificationAdmission({
    descriptor: policy.admission,
    repository,
    candidateSha,
    qualificationSha: policy.sha,
    workflowRef,
  });
  requireValue(
    ![original.request.requestId, request.requestId].includes(admission.request.requestId),
    "waiver policy requires a separate admission request",
  );
  same(
    admission.request,
    receiptRecoveryPolicyRequest(original, policy.sha, admission.request.requestId),
    "waiver policy admission changed original qualification inputs",
  );
  for (const key of ["coverage", "baselinePolicy", "workflowSourceDigest", "policySourceDigest"]) {
    same(admission[key], original[key], "waiver policy admission changed original " + key);
  }
  const read = (policySourceSha) =>
    readReleaseValidationWaiversAsync((path) => client.getWorkflowSource(policySourceSha, path));
  const oldLedger = await read(qualificationSha);
  const waiverPolicy = await read(policy.sha);
  const additions = waiverPolicy.slice(oldLedger.length);
  same(waiverPolicy.slice(0, oldLedger.length), oldLedger, "waiver policy changed existing grants");
  requireValue(
    additions.length > 0 &&
      additions.every((grant) => {
        const child = request.children[grant.childRole];
        return (
          grant.targetSha === candidateSha &&
          grant.targetVersion === original.baselinePolicy.candidateVersion &&
          original.coverage.children.some(({ key }) => key === grant.childRole) &&
          releaseWaiverEvidenceMatches(grant.evidence, child?.runId, child?.runAttempt) &&
          grant.qualificationExemption === undefined
        );
      }),
    "waiver policy must append grants scoped to original C, version and selected receipt attempts",
  );
  await revalidateReceiptRecoveryPolicy(request, admission, client);
  return { admission, waiverPolicy };
}

async function revalidateReceiptRecoveryPolicy(request, admission, client) {
  const descriptor = request.policyQualification.admission;
  const run = await client.getRun(String(descriptor.runId));
  requireValue(
    run.id === descriptor.runId &&
      run.run_attempt === descriptor.runAttempt &&
      run.status === "completed" &&
      run.conclusion === "success",
    "waiver policy admission attempt changed",
  );
  client.revalidateQualificationAdmissionAuthority({ descriptor, admission });
}

export function receiptRecoverySourceRequest(admission, producer) {
  const original = admission.request;
  const scope = resolveAdmittedQualificationScope(admission);
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
    PUBLICATION_SKIP_TELEGRAM: String(scope.skipPackageTelegramE2e),
    PUBLICATION_COVERAGE_POLICY: scope.coveragePolicy ?? "",
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

async function readPayload(repository, artifact, workflowSha, deps, mode, providedMetadata) {
  const metadata = providedMetadata ?? (await deps.client.getArtifact(artifact.id));
  const expected = {
    repository,
    runId: Number(artifact.runId),
    workflowSha,
    artifactId: Number(artifact.id),
    artifactName: artifact.name,
    artifactDigest: "sha256:" + artifact.digest.replace(/^sha256:/u, ""),
    artifactExpiresAt: artifact.expiresAt ?? metadata.expires_at,
    artifactSizeBytes: artifact.sizeBytes ?? metadata.size_in_bytes,
  };
  if (mode === "metadata") {
    validateArtifactMetadata(metadata, expected);
    return expected.artifactDigest;
  }
  const downloaded =
    mode === "digest"
      ? await verifyExactActionsArtifactDigest({ expected, token: deps.token })
      : await deps.client.downloadArtifactArchive({ expected, token: deps.token });
  return mode === "digest" ? downloaded.digest : downloaded.archiveBytes;
}

// authenticatedPayloads is accepted only after the recovery reader authenticates
// the original successful seal. Admission omits it and verifies every payload byte.
export async function verifyOriginalReceiptQualification(requestValue, dependencies = {}) {
  const request = validateReceiptRecoveryRequest(requestValue);
  const client = dependencies.client ?? createReleaseEvidenceClient(request.repository);
  const deps = { client, token: process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN };
  const authenticatedPayloads = dependencies.authenticatedPayloads;
  requireValue(
    authenticatedPayloads === undefined || Array.isArray(authenticatedPayloads),
    "authenticated payload inventory must be an array",
  );
  const binding = request.candidateBinding;
  const target = binding?.request?.targetSha;
  const qualificationSha = binding?.request?.toolingSha;
  requireValue(
    /^[a-f0-9]{40}$/u.test(target) && /^[a-f0-9]{40}$/u.test(qualificationSha),
    "original candidate and qualification must identify commits",
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
    ["beta", "stable", "full"].includes(admission.request.inputs.release_profile) &&
      admission.request.inputs.rerun_group === "all" &&
      admission.request.inputs.mode === "both",
    "only complete admitted qualification can be recovered",
  );
  const scope = resolveAdmittedQualificationScope(admission);
  const baselines = validateQualificationBaselinePolicy(
    admission.request,
    admission.baselinePolicy,
  );
  requireValue(
    binding.package.version === admission.baselinePolicy.candidateVersion &&
      binding.request.releaseProfile === scope.releaseProfile &&
      binding.request.releaseSoak === scope.runReleaseSoak,
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
    Object.keys(request.children).toSorted(),
    admission.coverage.children.map((child) => child.key).toSorted(),
    "recovery must include exactly the admitted child roles",
  );
  requireValue(
    parent.status === "completed" &&
      ["success", "failure"].includes(parent.conclusion) &&
      Number(parent.run_attempt) === request.originalParent.runAttempt &&
      parent.head_sha === qualificationSha &&
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
  // Missing-plan recovery remains supported. If a plan exists, it is
  // evidence, not an optional hint: use the original admission's sealing owner.
  const artifacts = await client.getRunArtifacts(request.originalParent.runId);
  if (
    artifacts.some(
      (entry) => entry.name === "full-release-execution-plan-" + request.originalParent.runId,
    )
  ) {
    const source = receiptRecoverySourceRequest(admission, {
      runId: request.originalParent.runId,
      runAttempt: 1,
      fullRef: "refs/heads/" + admission.request.transportRef,
      sha: qualificationSha,
    });
    const { plan } = await restoreOriginalPublicationAdmission({ request: source, client });
    same(
      plan.qualificationCoverage,
      admission.coverage,
      "original plan coverage differs from admission",
    );
    same(plan.candidateRequest, binding.request, "original plan candidate request changed");
    if (plan.candidate) {
      same(plan.candidate, binding, "original plan candidate binding changed");
    }
    same(
      plan.children
        .filter((child) => child.selected)
        .map((child) => child.key)
        .toSorted(),
      Object.keys(request.children).toSorted(),
      "original plan selected child inventory changed",
    );
    for (const child of plan.children.filter((entry) => entry.selected)) {
      const selected = request.children[child.key];
      same(child.runId, selected.runId, "original plan child selection changed: " + child.key);
      if (plan.childReuse?.[child.key]) {
        same(
          plan.childReuse[child.key],
          selected,
          "original adopted receipt changed: " + child.key,
        );
      }
    }
  }
  await verifySealedFullReleaseCandidate({
    binding,
    downloadArchive: (options) => client.downloadArtifactArchive(options),
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
  const policyQualification = await verifyReceiptRecoveryPolicy(request, admission, client);
  const waiverPolicy =
    policyQualification?.waiverPolicy ??
    (await readReleaseValidationWaiversAsync((path) =>
      client.getWorkflowSource(qualificationSha, path),
    ));
  const children = [];
  for (const { key: role } of admission.coverage.children) {
    const selection = request.children[role];
    const fresh = selection.sourceParentRunId === request.originalParent.runId;
    if (fresh) {
      requireValue(
        selection.sourceParentAttempt === 1 &&
          selection.workflowRef === admission.request.transportRef,
        "child does not belong to the original parent",
      );
    }
    const spec = releaseChildSpec(role);
    const source = client.getWorkflowSource(qualificationSha, ".github/workflows/" + spec.workflow);
    const inputs = qualificationChildDispatchInputs(role, admission, binding, source);
    const verified = await client.validateChildReuse(
      selection,
      {
        repository: request.repository,
        targetSha: target,
        workflowSha: qualificationSha,
        role,
        inputs,
        policyTargetVersion: binding.package.version,
      },
      // Recovery must enumerate every historical attempt, including long rerun chains.
      { deadlineMs: Date.now() + 10 * 60_000, waiverPolicy },
    );
    const coverage = admission.coverage.children.find((child) => child.key === role);
    const child = {
      key: role,
      runId: selection.runId,
      runAttempt: selection.runAttempt,
      status: verified.run.status,
      conclusion: verified.run.conclusion,
      jobs: verified.receipt.jobs,
    };
    requireValue(
      terminalPolicyPass(child, binding.package.version, target, waiverPolicy),
      "original child failed release policy",
    );
    const policy = evaluateReleaseChildPolicy({
      child,
      targetVersion: binding.package.version,
      targetSha: target,
      waiverPolicy,
    });
    // Reuse the admitted workload inventory and authenticated composite; recovery
    // does not reconstruct a second matrix policy from historical source files.
    validateQualificationJobs(
      verified.receipt.jobs,
      coverage.requiredJobs,
      "Original " + role,
      policy.waivedJobNames,
    );

    if (role === "productPerformance") {
      validatePerformanceArtifactOnlyJobs(verified.receipt.jobs);
    }
    const dispatchJobs = parentJobs.filter((job) => job.name === coverage.parentJobName);
    requireValue(
      dispatchJobs.length === 1 &&
        dispatchJobs[0].status === "completed" &&
        dispatchJobs[0].conclusion === "success",
      "original dispatch did not succeed exactly once",
    );
    validateReleaseChildDispatchBinding({
      child: { key: role, runId: selection.runId },
      childReuse: fresh ? undefined : selection,
      log: await client.getJobLog(dispatchJobs[0].id),
      coveragePolicy: scope.coveragePolicy,
      plannedRunAttempt: 1,
      repository: request.repository,
      targetSha: target,
    });
    children.push({
      role,
      runId: selection.runId,
      runAttempt: selection.runAttempt,
      workflowSha: verified.selection.workflowSha,
      sourceParentRunId: selection.sourceParentRunId,
      conclusion: verified.run.conclusion,
      waivers: policy.waivers,
      advisoryJobs: releaseChildAdvisories(child),
      receipt: verified.receipt,
    });
  }
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
  const selection = JSON.parse(admission.request.inputs.trusted_workflow_json).publicationSelection;
  const publication = await client.verifyRetainedPublicationArtifacts(
    originalRoot,
    {
      GITHUB_REPOSITORY: request.repository,
      TARGET_SHA: target,
      PARENT_WORKFLOW_SHA: qualificationSha,
      RELEASE_TAG: "v" + binding.package.version,
      PLUGIN_NPM_REQUIRED: String(selection.pluginPublishScope !== "none"),
    },
    {
      verifyPayloads: true,
      ...(authenticatedPayloads ? { authenticatedPayloads } : {}),
      // Large Docker bodies may need the full transfer budget; metadata stays capped at 60s.
      dockerArchiveTimeoutMs: 4 * 60_000,
      expectedPackage: {
        fileName: binding.package.fileName,
        sha256: binding.package.packageSha256,
      },
    },
  );
  const plugin = request.publicationArtifacts.pluginNpm;
  if (selection.pluginPublishScope !== "none") {
    const pluginArtifact = {
      id: plugin.artifactId,
      name: plugin.artifactName,
      runId: plugin.runId,
      digest: plugin.artifactDigest,
    };
    const pluginFiles = inspectActionsArtifactZip(
      await readPayload(request.repository, pluginArtifact, qualificationSha, deps),
      [PREPARED_NPM_MANIFEST],
    );
    const preparedPlugins = validatePreparedNpmRelease(
      JSON.parse(pluginFiles.get(PREPARED_NPM_MANIFEST).toString("utf8")),
      {
        repository: request.repository,
        sourceSha: target,
        workflowSha: qualificationSha,
        npmDistTag: selection.npmDistTag === "extended-stable" ? "extended-stable" : "default",
        selectionMode: selection.pluginPublishScope,
        plugins: selection.plugins.join(","),
        publisherPolicySha256: sha(client.getWorkflowSource(qualificationSha, plugin.workflowPath)),
      },
    );
    // One fresh bounded inventory replaces an N-request metadata fanout; it is
    // local to this authentication and never persisted in immutable replay.
    const pluginArtifacts = authenticatedPayloads
      ? new Map((await client.getRunArtifacts(plugin.runId)).map((entry) => [entry.id, entry]))
      : undefined;
    for (const entry of preparedPlugins.packages) {
      const metadata = pluginArtifacts?.get(entry.artifact.artifactId);
      requireValue(!pluginArtifacts || metadata, "retained plugin payload is unavailable");
      const bytes = await readPayload(
        request.repository,
        {
          id: entry.artifact.artifactId,
          name: entry.artifact.artifactName,
          runId: entry.artifact.runId,
          digest: entry.artifact.artifactDigest,
          sizeBytes: entry.artifact.artifactSizeBytes,
        },
        qualificationSha,
        deps,
        authenticatedPayloads ? "metadata" : "archive",
        metadata,
      );
      publication.payloads.push({
        kind: "plugin-npm-package",
        artifact: entry.artifact,
        sha256: authenticatedPayloads ? bytes.slice("sha256:".length) : sha(bytes),
      });
    }
  }
  for (const [kind, constituent] of [
    ["candidate-shared-image", binding.sharedImage],
    ["candidate-plugin-registry", binding.prepublishPluginRegistry],
  ]) {
    const digest = await readPayload(
      request.repository,
      constituent.artifact,
      qualificationSha,
      deps,
      authenticatedPayloads ? "metadata" : "digest",
    );
    publication.payloads.push({
      kind,
      artifact: constituent.artifact,
      sha256: digest.slice("sha256:".length),
    });
  }
  // The authenticated recovery seal attests the package equality check below.
  // Consumers still bind its current artifact; the selected npm consumer checks bytes at use.
  if (authenticatedPayloads) {
    await readPayload(
      request.repository,
      binding.package.artifact,
      qualificationSha,
      deps,
      "metadata",
    );
  } else {
    // The independently produced candidate package must contain the same tgz as
    // the original qualified npm bundle, not merely an identically named package.
    const packageBytes = await readPayload(
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
  }
  if (authenticatedPayloads) {
    same(
      authenticatedPayloads,
      publication.payloads,
      "original publication payload inventory changed",
    );
  }
  await revalidateReceiptRecoveryRuns(request, client, children, parent);
  if (policyQualification) {
    await revalidateReceiptRecoveryPolicy(request, policyQualification.admission, client);
  }
  client.revalidateQualificationAdmissionAuthority({
    descriptor: request.qualificationAdmission,
    admission,
  });
  return {
    admission,
    policyAdmission: policyQualification?.admission,
    children,
    originalRoot,
    publication,
    originalParent: parent,
  };
}

export async function revalidateReceiptRecoveryRuns(
  request,
  client,
  verifiedChildren,
  originalParent,
) {
  const tuples = [
    request.originalParent,
    ...Object.values(request.children),
    request.candidateBinding.producer,
    request.publicationArtifacts.npmPreflight.producer,
    {
      runId: request.publicationArtifacts.docker.preparedRunId,
      runAttempt: request.publicationArtifacts.docker.preparedRunAttempt,
    },
    request.publicationArtifacts.pluginNpm,
  ];
  const seen = new Set();
  for (const tuple of tuples.filter(Boolean)) {
    if (seen.has(String(tuple.runId))) {
      continue;
    }
    seen.add(String(tuple.runId));
    const current = await client.getRun(String(tuple.runId));
    const parent = String(tuple.runId) === request.originalParent.runId;
    const verifiedChild = verifiedChildren?.find((child) => child.runId === String(tuple.runId));
    const conclusion =
      parent && originalParent && (tuple.currentRunAttempt ?? tuple.runAttempt) === tuple.runAttempt
        ? originalParent.conclusion
        : verifiedChild?.conclusion;
    requireValue(
      String(current.id) === String(tuple.runId) &&
        Number(current.run_attempt) ===
          Number(parent ? (tuple.currentRunAttempt ?? tuple.runAttempt) : tuple.runAttempt) &&
        current.head_sha ===
          (verifiedChild?.workflowSha ?? request.candidateBinding.request.toolingSha) &&
        current.status === "completed" &&
        (conclusion
          ? current.conclusion === conclusion
          : parent
            ? ["success", "failure"].includes(current.conclusion)
            : current.conclusion === "success"),
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
  requireValue(
    Array.isArray(manifest.retainedPublicationPayloads),
    "sealed payload inventory is unavailable",
  );
  const producer = producerFromManifest(manifest);
  requireValue(
    request.workflowSha === undefined || request.workflowSha === producer.sha,
    "aggregate did not execute the selected recovery P",
  );
  const revalidateRecoveryAuthority = () =>
    client.verifyReceiptRecoveryAuthority
      ? client.verifyReceiptRecoveryAuthority(producer)
      : verifyReceiptRecoveryAuthority(request.repository, producer);
  revalidateRecoveryAuthority();
  const workflow = client.getWorkflowSource(producer.sha, RECEIPT_RECOVERY_WORKFLOW);
  requireValue(
    /^ {2}FULL_RELEASE_RECEIPT_RECOVERY_CONTRACT: "1"$/mu.test(workflow),
    "missing immutable recovery contract",
  );
  requireValue(
    run.name === "Receipt Recovery " + request.requestId &&
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
      manifest.rerunGroup === "all" &&
      manifest.sourceParentRunAttempt === producer.runAttempt &&
      !manifest.evidenceReuse &&
      !manifest.executionPlanSha256 &&
      !manifest.qualificationCoverage &&
      !manifest.sourceAdmission?.qualificationAdmission &&
      !manifest.candidateBinding,
    "aggregate must not impersonate historical qualification",
  );
  same(
    manifest.controls,
    {
      stableSoakRequired: ["stable", "full"].includes(manifest.releaseProfile),
      performanceBlocking: manifest.releaseProfile !== "beta",
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
    Object.fromEntries(
      Object.entries(request.children).map(([role, child]) => [role, child.runId]),
    ),
    "aggregate changed original children",
  );
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
  const observationBytes = await readPayload(
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
  // Only this authenticated, ordered successful seal may supply prior content
  // verification. Reconstruct the inventory from original descriptors and live
  // metadata; neither the seal nor its hashes replace current authority checks.
  const verified = await verifyOriginalReceiptQualification(request, {
    client,
    authenticatedPayloads: manifest.retainedPublicationPayloads,
  });
  same(
    manifest.waivers,
    verified.children.flatMap((child) => child.waivers),
    "aggregate waivers differ from trusted policy",
  );
  same(
    manifest.advisoryJobs,
    verified.children.flatMap((child) => child.advisoryJobs),
    "aggregate advisories differ from trusted policy",
  );
  const scope = resolveAdmittedQualificationScope(verified.admission);
  same(manifest.releaseProfile, scope.releaseProfile, "aggregate changed original profile");
  same(manifest.runReleaseSoak, String(scope.runReleaseSoak), "aggregate changed original soak");
  const expectedSource = receiptRecoverySourceRequest(verified.admission, producer);
  const source = validatePublicationSourceBinding(manifest);
  requireValue(
    source.projection.version === verified.admission.baselinePolicy.candidateVersion,
    "fresh publication source changed the candidate version",
  );
  for (const [key, value] of Object.entries(expectedSource)) {
    same(source[key], value, "fresh source changed original " + key);
  }
  if (expectedRunAttempts) {
    for (const [id, attempt] of [
      [producer.runId, producer.runAttempt],
      ...Object.values(request.children).map((child) => [child.runId, child.runAttempt]),
    ]) {
      same(expectedRunAttempts.get(id), attempt, "expected attempt changed: " + id);
      expectedRunAttempts.delete(id);
    }
    requireValue(expectedRunAttempts.size === 0, "unexpected run-attempt constraints");
  }
  // The original qualification owner just refreshed its runs and admission.
  // Only synchronous binding checks intervene; recovery authority is separate.
  revalidateRecoveryAuthority();
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
    waivers: verified.children.flatMap((child) => child.waivers),
    conclusions: {
      current: "success",
      root: "success",
      children: Object.fromEntries(
        verified.children.map((child) => [child.role, child.conclusion]),
      ),
    },
    controls: manifest.controls,
    directRoot: true,
    evidenceReuse: null,
    executionPlan: null,
    releaseProfile: scope.releaseProfile,
    rerunGroup: "all",
    runReleaseSoak: scope.runReleaseSoak,
    repository: request.repository,
    qualificationAdmission: verified.admission,
    policyAdmission: verified.policyAdmission ?? null,
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
    sha: env.GITHUB_WORKFLOW_SHA || env.GITHUB_SHA,
  };
  const request = validateReceiptRecoveryRequest(JSON.parse(env.RECEIPT_RECOVERY_REQUEST));
  requireValue(
    request.workflowSha === undefined || request.workflowSha === producer.sha,
    "workflow did not execute the selected recovery P; retain this request and select a new reviewed P",
  );
  verifyReceiptRecoveryAuthority(request.repository, producer, false);
  mkdirSync(directory, { recursive: true });
  if (process.argv[2] === "request") {
    writeFileSync(join(directory, "request.json"), JSON.stringify(request) + "\n", { mode: 0o600 });
  } else if (process.argv[2] === "admit") {
    const verified = await verifyOriginalReceiptQualification(request);
    writeFileSync(
      join(directory, "verified-qualification.json"),
      JSON.stringify({
        payloads: verified.publication.payloads,
        children: verified.children,
        originalParent: verified.originalParent,
      }),
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
    if (verified.policyAdmission) {
      await revalidateReceiptRecoveryPolicy(
        request,
        verified.policyAdmission,
        createReleaseEvidenceClient(request.repository),
      );
    }
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
    const verified = json(join(directory, "verified-qualification.json"));
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
      retainedPublicationPayloads: verified.payloads,
      waivers: verified.children.flatMap((child) => child.waivers),
      advisoryJobs: verified.children.flatMap((child) => child.advisoryJobs),
      controls: {
        stableSoakRequired: ["stable", "full"].includes(context.releaseProfile),
        performanceBlocking: context.releaseProfile !== "beta",
        performanceReportPublication: "artifact-only",
      },
      childRuns: Object.fromEntries(
        Object.entries(request.children).map(([role, child]) => [role, child.runId]),
      ),
    };
    const client = createReleaseEvidenceClient(request.repository);
    await revalidateReceiptRecoveryRuns(
      request,
      client,
      verified.children,
      verified.originalParent,
    );
    const originalAdmission = client.verifyQualificationAdmission({
      descriptor: request.qualificationAdmission,
      repository: request.repository,
      candidateSha: manifest.targetSha,
      qualificationSha: request.candidateBinding.request.toolingSha,
      workflowRef: verified.originalParent.head_branch,
    });
    await verifyReceiptRecoveryPolicy(request, originalAdmission, client);
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
    throw new Error("Expected request, admit or seal");
  }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
