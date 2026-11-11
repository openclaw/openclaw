#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import {
  downloadActionsArtifactArchive,
  inspectActionsArtifactZipWithPolicy,
  readBoundedRegularFile,
  readBoundedResponseBody,
  validateActionsArtifactBinding,
  validateActionsArtifactProducerJob,
} from "./lib/actions-artifact-archive.mjs";
import {
  classifyNpmDistTagVersion,
  fetchNpmRegistryPackumentWithRetry,
  fetchNpmRegistryTarballWithRetry,
  npmRegistryReadbackDeadline,
  NpmRegistryUnavailableError,
  resolveNpmPublishPlan,
} from "./lib/npm-publish-plan.mjs";
import { accountGithubRequest, withGithubRequestBudget } from "./lib/plain-gh.mjs";
import { collectExtensionPackageJsonCandidates } from "./lib/plugin-publication-candidates.ts";
import { isPluginPublicationEnabled } from "./lib/plugin-publication-target.mjs";
import { retainedPublicationArtifactSource } from "./lib/release-evidence-identity.mjs";
import { createReleaseEvidenceReplay } from "./lib/release-evidence-replay.mjs";
import { parseReleaseVersion } from "./lib/release-version.mjs";
import { loadNpmEvidenceReplay, npmEvidenceBinding } from "./plugin-npm-evidence-reuse.mjs";
import {
  inspectPackageTarballBytes,
  verifyPluginPublicationArtifact,
} from "./plugin-publication-artifact.mjs";
import { downloadReleaseApprovalReceipt } from "./release-approval-receipt.mjs";

export const PREPARED_NPM_MANIFEST = "plugin-npm-prepared.json";
const SCHEMA = "openclaw.plugin-npm-prepared/v1";
const WORKFLOW_PATH = ".github/workflows/plugin-npm-release.yml";
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_PACKAGE_BYTES = 256 * 1024 * 1024;
const SHA = /^[a-f0-9]{40}$/u;
const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const PACKAGE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u;
const ROUTES = new Set(["npm-oidc", "npm-token-bootstrap", "npm-readback"]);

function requireValue(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function readJson(file, maxBytes = MAX_MANIFEST_BYTES) {
  return JSON.parse(readBoundedRegularFile(file, { label: file, maxBytes }).toString("utf8"));
}

function normalizeProducer(value) {
  requireValue(
    value?.workflowPath === WORKFLOW_PATH &&
      value.workflowEvent === "workflow_dispatch" &&
      /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(value.repository ?? "") &&
      SHA.test(value.workflowSha ?? "") &&
      Number.isSafeInteger(value.runId) &&
      value.runId > 0 &&
      Number.isSafeInteger(value.runAttempt) &&
      value.runAttempt > 0 &&
      typeof value.workflowHeadBranch === "string" &&
      /^(?:main|release\/[0-9]{4}\.[1-9][0-9]*\.[1-9][0-9]*|extended-stable\/[0-9]{4}\.[1-9][0-9]*\.33|release-ci\/[a-f0-9]{12}-[1-9][0-9]*|release-publish\/[a-f0-9]{12}-[1-9][0-9]*)$/u.test(
        value.workflowHeadBranch,
      ),
    "Prepared npm producer must bind an exact trusted workflow run and attempt.",
  );
  return {
    repository: value.repository,
    runId: value.runId,
    runAttempt: value.runAttempt,
    workflowPath: value.workflowPath,
    workflowEvent: value.workflowEvent,
    workflowHeadBranch: value.workflowHeadBranch,
    workflowSha: value.workflowSha,
  };
}

function normalizePackage(value, npmDistTag) {
  requireValue(
    /^[a-z0-9][a-z0-9._-]*$/u.test(value?.extensionId ?? "") &&
      value.packageDir === `extensions/${value.extensionId}` &&
      PACKAGE.test(value.packageName ?? "") &&
      typeof value.installNpmSpec === "string" &&
      value.installNpmSpec.length > 0 &&
      !/[\s\p{Cc}]/u.test(value.installNpmSpec),
    "Prepared npm package identity is invalid.",
  );
  const plan = resolveNpmPublishPlan(
    value.version,
    undefined,
    npmDistTag === "default" ? undefined : npmDistTag,
  );
  requireValue(
    value.channel === plan.channel && value.publishTag === plan.publishTag,
    "Prepared npm package channel differs from its version.",
  );
  return {
    extensionId: value.extensionId,
    packageDir: value.packageDir,
    packageName: value.packageName,
    version: value.version,
    channel: value.channel,
    publishTag: value.publishTag,
    installNpmSpec: value.installNpmSpec,
  };
}

function artifactTuple(metadata, producer) {
  requireValue(
    Number.isSafeInteger(metadata.id) &&
      metadata.id > 0 &&
      typeof metadata.name === "string" &&
      /^[A-Za-z0-9][A-Za-z0-9_.-]*$/u.test(metadata.name) &&
      DIGEST.test(metadata.digest ?? "") &&
      Number.isSafeInteger(metadata.size_in_bytes) &&
      metadata.size_in_bytes > 0 &&
      metadata.size_in_bytes <= MAX_PACKAGE_BYTES,
    "Prepared npm artifact identity is invalid.",
  );
  return {
    ...producer,
    artifactId: metadata.id,
    artifactName: metadata.name,
    artifactDigest: metadata.digest,
    artifactSizeBytes: metadata.size_in_bytes,
  };
}

function packageArtifactName(entry, route, producer) {
  return `plugin-npm-package-${entry.extensionId}-${entry.version}-${route}-${producer.runId}-${producer.runAttempt}`;
}

export function preparedNpmArtifactName(sourceSha, producer) {
  requireValue(SHA.test(sourceSha), "Prepared npm source must be a full lowercase SHA.");
  const identity = normalizeProducer(producer);
  return `plugin-npm-prepared-${sourceSha}-${identity.runId}-${identity.runAttempt}`;
}

export function validatePreparedNpmArtifactDescriptor(value, expected) {
  const producer = normalizeProducer(value);
  requireValue(
    producer.repository === expected.repository &&
      producer.workflowSha === expected.workflowSha &&
      value.artifactName === preparedNpmArtifactName(expected.sourceSha, producer),
    "Prepared npm artifact descriptor differs from the approved source or tooling.",
  );
  return artifactTuple(
    {
      id: value.artifactId,
      name: value.artifactName,
      digest: value.artifactDigest,
      size_in_bytes: value.artifactSizeBytes,
    },
    producer,
  );
}

// P consumes Q's bytes as data. Neither a caller-supplied Q SHA nor a matching
// artifact name grants authority: the original successful FRV attempt owns it.
export async function authenticatePreparedNpmArtifact(params) {
  return authenticatePreparedNpmArtifactEvidence(params, true);
}

// Only the CLI owns the deferred boundary: every successful load, consume or
// authorize below revalidates after its last acquisition and before its output.
// Public callers retain the return-time authority check.
async function authenticatePreparedNpmArtifactEvidence(params, revalidateOnReturn) {
  const { repository, sourceSha, workflowSha, artifact } = params;
  if (!params.fullReleaseValidationRunId && !params.fullReleaseValidationRunAttempt) {
    return {
      artifact: validatePreparedNpmArtifactDescriptor(artifact, params),
      workflowSha,
      publisherPolicySha256: params.publisherPolicySha256,
      revalidateAuthority: undefined,
    };
  }
  requireValue(
    [params.fullReleaseValidationRunId, params.fullReleaseValidationRunAttempt].every(
      (value) => /^[1-9][0-9]*$/u.test(String(value)) && Number.isSafeInteger(Number(value)),
    ),
    "Prepared npm adoption requires the exact FRV run and attempt.",
  );
  const { createReleaseEvidenceClient } = await import("./release-ci-summary.mjs");
  const { authenticateFullReleaseValidationEvidence, revalidateCandidateArtifactAuthority } =
    await import("./validate-full-release-validation-evidence.mjs");
  const client =
    params.evidenceClient ??
    createReleaseEvidenceClient(repository, { immutableReads: params.immutableReads });
  // Only the private CLI path may consume the carrier-authenticated projection.
  // Exported helpers must not accept a caller-forged transport property as proof.
  const prepared = !revalidateOnReturn && params.immutableReads?.authenticatedPreparedEvidence;
  if (prepared) {
    const descriptor = validatePreparedNpmArtifactDescriptor(prepared.artifact, {
      repository,
      sourceSha,
      workflowSha: prepared.workflowSha,
    });
    requireValue(
      !artifact || isDeepStrictEqual(artifact, descriptor),
      "Prepared npm artifact differs from the authenticated preview descriptor.",
    );
    const revalidateAuthority = async () => {
      await params.immutableReads.revalidate(client);
      revalidateCandidateArtifactAuthority(prepared.publicationAuthority, client);
    };
    if (revalidateOnReturn) {
      await revalidateAuthority();
    }
    return { ...prepared, artifact: descriptor, evidenceClient: client, revalidateAuthority };
  }
  const runId = String(params.fullReleaseValidationRunId);
  const runAttempt = Number(params.fullReleaseValidationRunAttempt);
  const { manifest } = await client.loadManifest(runId, runAttempt);
  const selected = manifest.sourceAdmission?.publicationSelection;
  // Derive the operation only after the validator authenticates the whole
  // admission. Its owner decides whether this is a covered plugin-only subset.
  let operation;
  const publicationOperation = () => {
    requireValue(
      selected &&
        (selected.npmDistTag === "extended-stable" ? "extended-stable" : "default") ===
          params.npmDistTag,
      "Prepared npm adoption differs from the admitted publication channel.",
    );
    requireValue(
      !params.publicationSelection || isDeepStrictEqual(params.publicationSelection, selected),
      "Prepared npm adoption differs from the expected original publication selection.",
    );
    operation = {
      ...selected,
      pluginPublishScope: params.selectionMode,
      plugins: (params.plugins ?? "")
        .split(/[,\s]+/u)
        .filter(Boolean)
        .toSorted(),
      publishOpenclawNpm: params.selectionMode === "selected" ? false : selected.publishOpenclawNpm,
    };
    return operation;
  };
  const authenticated = await authenticateFullReleaseValidationEvidence(
    {
      run: await client.getRunAttempt(runId, runAttempt),
      manifest,
      expectedRepository: repository,
      expectedRunId: runId,
      expectedRunAttempt: runAttempt,
      expectedTargetSha: sourceSha,
      expectedReleaseTag: params.releaseTag ?? `v${manifest.sourceAdmission?.projection?.version}`,
      expectedTrustedWorkflowFullRef: params.workflowFullRef,
      expectedTrustedWorkflowSha: workflowSha,
      ...(selected
        ? { expectedPublicationOperation: publicationOperation }
        : { expectedPublicationSelection: params.publicationSelection }),
      verifierSourceSha: workflowSha,
      verifierSourceContent: readFileSync(new URL("./release-ci-summary.mjs", import.meta.url)),
      isTrustedMainAncestor:
        params.isTrustedMainAncestor ??
        ((sha) => {
          const comparison = client.compareCommits(sha, "main");
          return (
            ["ahead", "identical"].includes(comparison.status) &&
            comparison.merge_base_commit?.sha === sha
          );
        }),
    },
    client,
  );
  const current = authenticated.evidence.current;
  const producerSha =
    retainedPublicationArtifactSource(current.manifest)?.workflow.sha ??
    current.manifest.workflowSha;
  if (producerSha !== workflowSha) {
    requireValue(
      producerSha === sourceSha &&
        current.workflowRefProof ===
          (current.manifest.receiptRecovery
            ? "receipt-backed-recovery-v1"
            : "candidate-owned-admission-v1") &&
        typeof authenticated.revalidateAuthority === "function",
      "Prepared npm Q != P adoption requires live candidate-owned qualification.",
    );
  }
  const descriptor = validatePreparedNpmArtifactDescriptor(
    current.manifest.publicationArtifacts?.pluginNpm,
    { repository, sourceSha, workflowSha: producerSha },
  );
  if (artifact) {
    requireValue(
      isDeepStrictEqual(
        validatePreparedNpmArtifactDescriptor(artifact, {
          repository,
          sourceSha,
          workflowSha: producerSha,
        }),
        descriptor,
      ),
      "Prepared npm artifact differs from the authenticated FRV descriptor.",
    );
  }
  const publisherPolicySha256 =
    producerSha === workflowSha && params.publisherPolicySha256 && !params.immutableReads
      ? params.publisherPolicySha256
      : sha256(client.getWorkflowSource(producerSha, WORKFLOW_PATH));
  if (params.immutableReads && producerSha === workflowSha && params.publisherPolicySha256) {
    requireValue(
      publisherPolicySha256 === params.publisherPolicySha256,
      "Prepared npm publisher policy differs from immutable source",
    );
  }
  // Replay validation is asynchronous; live qualification authority is synchronous.
  /** @type {(() => void | Promise<void>) | undefined} */
  const revalidateAuthority = params.immutableReads
    ? async () => {
        await params.immutableReads.revalidate(client);
        authenticated.revalidateAuthority?.();
      }
    : authenticated.revalidateAuthority;
  if (revalidateOnReturn) {
    await revalidateAuthority?.();
  }
  return {
    artifact: descriptor,
    workflowSha: producerSha,
    publisherPolicySha256,
    publicationSelection: selected,
    publicationOperation: operation,
    publicationAuthority: authenticated.publicationAuthority,
    evidenceClient: params.immutableReads ? client : undefined,
    revalidateAuthority,
  };
}

function sourcePackageRoster(sourceRoot, npmDistTag, selectedNames) {
  return collectExtensionPackageJsonCandidates(sourceRoot)
    .filter(({ packageJson }) => isPluginPublicationEnabled(packageJson, "npm"))
    .filter(
      ({ packageJson }) =>
        selectedNames.length === 0 || selectedNames.includes(packageJson.name?.trim()),
    )
    .map(({ extensionId, packageDir, packageJson }) => {
      const plan = resolveNpmPublishPlan(
        packageJson.version,
        undefined,
        npmDistTag === "default" ? undefined : npmDistTag,
      );
      return normalizePackage(
        {
          extensionId,
          packageDir,
          packageName: packageJson.name?.trim(),
          version: packageJson.version?.trim(),
          channel: plan.channel,
          publishTag: plan.publishTag,
          installNpmSpec: packageJson.openclaw?.install?.npmSpec?.trim(),
        },
        npmDistTag,
      );
    })
    .toSorted((a, b) =>
      a.packageName < b.packageName ? -1 : a.packageName > b.packageName ? 1 : 0,
    );
}

export function validatePreparedNpmRelease(manifest, expected) {
  const producer = normalizeProducer(manifest?.producer);
  requireValue(
    manifest.schema === SCHEMA &&
      manifest.runtimeQualification === "packed-runtime-v1" &&
      SHA.test(manifest.sourceSha ?? "") &&
      manifest.sourceSha === expected.sourceSha &&
      manifest.npmDistTag === expected.npmDistTag &&
      ["default", "extended-stable"].includes(manifest.npmDistTag) &&
      manifest.selectionMode === expected.selectionMode &&
      ["selected", "all-publishable"].includes(manifest.selectionMode) &&
      manifest.publisherPolicySha256 === expected.publisherPolicySha256 &&
      /^[a-f0-9]{64}$/u.test(manifest.publisherPolicySha256 ?? "") &&
      producer.repository === expected.repository &&
      producer.workflowSha === expected.workflowSha,
    "Prepared npm release differs from the approved source, tooling, selection, or channel.",
  );
  requireValue(
    Array.isArray(manifest.packages) &&
      manifest.packages.length > 0 &&
      manifest.packages.length <= 256,
    "Prepared npm release must contain the complete non-empty package roster.",
  );
  const names = new Set();
  const artifacts = new Set();
  const packages = manifest.packages.map((value) => {
    const entry = normalizePackage(value, manifest.npmDistTag);
    const tuple = value.artifact;
    requireValue(
      ROUTES.has(value.route),
      "Prepared npm route requires separately authorized repair tooling.",
    );
    if (value.route === "npm-token-bootstrap") {
      const parsed = parseReleaseVersion(entry.version);
      requireValue(
        entry.channel === "beta" ||
          (parsed?.channel === "stable" &&
            parsed.patch < 33 &&
            manifest.npmDistTag === "default" &&
            entry.publishTag === "latest"),
        "Prepared npm token bootstrap requires beta or regular stable/latest qualification.",
      );
    }
    requireValue(
      JSON.stringify(normalizeProducer(tuple)) === JSON.stringify(producer),
      "Prepared npm package producer differs from the sealed release.",
    );
    const normalizedTuple = artifactTuple(
      {
        id: tuple.artifactId,
        name: tuple.artifactName,
        digest: tuple.artifactDigest,
        size_in_bytes: tuple.artifactSizeBytes,
      },
      producer,
    );
    requireValue(
      normalizedTuple.artifactName === packageArtifactName(entry, value.route, producer),
      "Prepared npm package artifact does not bind its exact producer attempt.",
    );
    requireValue(
      !names.has(entry.packageName) && !artifacts.has(tuple.artifactId),
      "Prepared npm release contains duplicate packages or artifacts.",
    );
    names.add(entry.packageName);
    artifacts.add(tuple.artifactId);
    return { ...entry, route: value.route, artifact: normalizedTuple };
  });
  const selected = (expected.plugins ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean)
    .toSorted();
  if (manifest.selectionMode === "all-publishable") {
    requireValue(
      selected.length === 0,
      "All-publishable prepared npm release must not narrow the roster.",
    );
  } else {
    requireValue(
      JSON.stringify(selected) ===
        JSON.stringify([...names].toSorted((a, b) => (a < b ? -1 : a > b ? 1 : 0))),
      "Prepared npm package roster differs from the requested selection.",
    );
  }
  if (expected.sourceRoot !== undefined) {
    const sourcePackages = sourcePackageRoster(expected.sourceRoot, manifest.npmDistTag, selected);
    requireValue(
      JSON.stringify(sourcePackages) ===
        JSON.stringify(packages.map((entry) => normalizePackage(entry, manifest.npmDistTag))),
      "Prepared npm roster differs from the complete selected frozen-source roster.",
    );
  }
  return { ...manifest, producer, packages };
}

export function createPreparedNpmRelease(params) {
  const producer = normalizeProducer(params.producer);
  const packages = params.matrix
    .map((value) => {
      const entry = normalizePackage(value, params.npmDistTag);
      const matches = params.artifacts.filter((artifact) =>
        [...ROUTES].some((route) => artifact.name === packageArtifactName(entry, route, producer)),
      );
      requireValue(
        matches.length === 1,
        `Expected one qualified npm artifact for ${entry.packageName}.`,
      );
      const [metadata] = matches;
      const route = [...ROUTES].find(
        (candidate) => metadata.name === packageArtifactName(entry, candidate, producer),
      );
      const artifact = artifactTuple(metadata, producer);
      const expected = {
        ...artifact,
        runStatePolicy: "same-run-producer-success",
        consumerRunAttempt: producer.runAttempt,
        producerJobName: `Preflight plugin npm package (${entry.packageName})`,
      };
      validateActionsArtifactBinding({
        artifactMetadata: metadata,
        expected,
        workflowRun: params.workflowRun,
      });
      validateActionsArtifactProducerJob({ expected, workflowJobs: params.workflowJobs });
      return { ...entry, route, artifact };
    })
    .toSorted((a, b) =>
      a.packageName < b.packageName ? -1 : a.packageName > b.packageName ? 1 : 0,
    );
  return validatePreparedNpmRelease(
    {
      schema: SCHEMA,
      runtimeQualification: "packed-runtime-v1",
      sourceSha: params.sourceSha,
      npmDistTag: params.npmDistTag,
      selectionMode: params.selectionMode,
      publisherPolicySha256: params.publisherPolicySha256,
      producer,
      packages,
    },
    { ...params, repository: producer.repository, workflowSha: producer.workflowSha },
  );
}

// First/last existing metadata responses, not extra quota probes. gh-backed
// evidence/authority reads are outside this boundary; these partial counts
// cannot establish a dispatch budget.
export function createPreparedNpmCapacityObserver(fetchImpl = fetch) {
  let before;
  let after;
  const requests = { fixed: 0, perPackage: 0 };
  const observe = (phase) => async (url, options) => {
    const response = await fetchImpl(url, options);
    const endpoint = new URL(url);
    // ZIP fetches follow storage redirects, whose headers are not GitHub quota.
    if (endpoint.hostname !== "api.github.com" || endpoint.pathname.endsWith("/zip")) {
      return response;
    }
    requests[phase] += 1;
    const capacity = {};
    for (const name of [
      "x-ratelimit-limit",
      "x-ratelimit-remaining",
      "x-ratelimit-used",
      "x-ratelimit-reset",
      "retry-after",
    ]) {
      const value = response.headers.get(name);
      if (value && /^[0-9]{1,16}$/u.test(value)) {
        capacity[name] = value;
      }
    }
    const resource = response.headers.get("x-ratelimit-resource");
    if (resource && /^[a-z_]{1,32}$/u.test(resource)) {
      capacity["x-ratelimit-resource"] = resource;
    }
    after = capacity;
    if (!before) {
      before = capacity;
      console.error(JSON.stringify({ githubCapacity: { phase: "before", ...before } }));
    }
    return response;
  };
  return {
    fetchImpl: observe("fixed"),
    packageFetchImpl: observe("perPackage"),
    report(packages) {
      console.error(
        JSON.stringify({
          githubCapacity: { phase: "after", ...after },
          githubRequestAccounting: { scope: "fetch-metadata-only", ...requests, packages },
        }),
      );
    },
  };
}

export async function downloadPreparedNpmRelease(params) {
  // Load verifies the full source roster; package consumers authenticate this
  // same sealed manifest and check their source package without a full checkout.
  const producer = normalizeProducer(params.artifact);
  requireValue(
    producer.repository === params.repository &&
      producer.workflowSha === params.workflowSha &&
      params.artifact.artifactName === preparedNpmArtifactName(params.sourceSha, producer),
    "Prepared npm manifest artifact differs from the approved producer.",
  );
  const download = {
    token: params.token,
    fetchImpl: params.fetchImpl,
    expected: { ...params.artifact, runStatePolicy: "completed-success" },
    archivePath: params.archivePath,
    maxArchiveBytes: MAX_MANIFEST_BYTES,
  };
  // Authenticated FRV consumers reuse only archive bytes; metadata and final
  // qualification authority stay live in every command.
  const downloaded = params.evidenceClient
    ? await params.evidenceClient.downloadArtifactArchive({
        ...download,
        expected: {
          ...download.expected,
          artifactExpiresAt: (await params.evidenceClient.getArtifact(params.artifact.artifactId))
            .expires_at,
        },
      })
    : await downloadActionsArtifactArchive(download);
  const files = inspectActionsArtifactZipWithPolicy(downloaded.archiveBytes, {
    minEntries: 1,
    maxEntries: 1,
    maxArchiveBytes: MAX_MANIFEST_BYTES,
    maxExpandedBytes: MAX_MANIFEST_BYTES,
    maxEntryBytes: () => MAX_MANIFEST_BYTES,
    allowPath: (name) => name === PREPARED_NPM_MANIFEST,
  });
  const manifest = validatePreparedNpmRelease(
    JSON.parse(files.get(PREPARED_NPM_MANIFEST).toString("utf8")),
    params,
  );
  requireValue(
    JSON.stringify(manifest.producer) === JSON.stringify(producer),
    "Prepared npm manifest producer differs from its artifact.",
  );
  return manifest;
}

export async function consumePreparedNpmPackage(params) {
  const entry = params.package;
  const producer = normalizeProducer(entry.artifact);
  normalizePackage(entry, params.npmDistTag);
  requireValue(
    producer.repository === params.repository &&
      producer.workflowSha === params.workflowSha &&
      ROUTES.has(entry.route) &&
      entry.artifact.artifactName === packageArtifactName(entry, entry.route, producer),
    "Prepared npm package differs from the approved publication identity.",
  );
  const cacheDir = resolve(params.cacheDir);
  mkdirSync(cacheDir, { recursive: true });
  const archivePath = join(cacheDir, `${entry.artifact.artifactId}.zip`);
  const downloaded = await downloadActionsArtifactArchive({
    token: params.token,
    fetchImpl: params.fetchImpl,
    expected: { ...entry.artifact, runStatePolicy: "completed-success" },
    archivePath,
  });
  params.immutableReads?.observeArchive(entry.artifact.artifactId, downloaded.artifactMetadata);
  const metadataPath = join(cacheDir, `${entry.artifact.artifactId}.metadata.json`);
  const runPath = join(cacheDir, `${entry.artifact.artifactId}.run.json`);
  writeFileSync(metadataPath, JSON.stringify(downloaded.artifactMetadata));
  writeFileSync(runPath, JSON.stringify(downloaded.workflowRun));
  return verifyPluginPublicationArtifact({
    ...entry.artifact,
    artifactMetadataPath: metadataPath,
    artifactZipPath: archivePath,
    workflowRunMetadataPath: runPath,
    runStatePolicy: "completed-success",
    packageDir: entry.packageDir,
    packageName: entry.packageName,
    version: entry.version,
    publishTag: entry.publishTag,
    route: entry.route,
    targetSha: params.sourceSha,
    publicationReason: `Stable npm registry preflight selected ${entry.route}.`,
    publisherPolicy: {
      policyId: "plugin-npm-release-workflow",
      schema: "openclaw.plugin-npm-publisher-policy/v1",
      sha256: params.publisherPolicySha256,
    },
    sourcePackageJsonSha256: sha256(
      readBoundedRegularFile(params.sourcePackageJson, {
        label: "source package.json",
        maxBytes: MAX_MANIFEST_BYTES,
      }),
    ),
    outputDir: params.outputDir,
    verificationOutput: params.verificationOutput,
  });
}

// Prune only after verifying the original qualified package, registry bytes, and
// selectors. Explicit parent-approved deferrals stay qualified, not published.
export async function selectUnpublishedPreparedNpmPackages(params) {
  const pending = [];
  const deferrals = params.corePluginDeferrals ?? [];
  requireValue(
    deferrals.every((deferred) =>
      params.packages.some(
        (entry) =>
          entry.packageName === deferred.packageName &&
          entry.version === deferred.version &&
          params.sourceSha === deferred.sourceSha,
      ),
    ),
    "Core deferral is outside the original qualified roster.",
  );
  for (const entry of params.packages) {
    const qualified = await consumePreparedNpmPackage({
      ...params,
      package: entry,
      sourcePackageJson: join(params.sourceRoot, entry.packageDir, "package.json"),
      outputDir: join(params.outputDir, entry.extensionId),
    });
    const { alreadyPublished } = await verifyPreparedNpmRegistry({
      packageName: entry.packageName,
      version: entry.version,
      publishTags: [entry.publishTag],
      route: entry.route,
      tarballPath: qualified.tarballPath,
      allowMissing: true,
      fetchImpl: params.fetchImpl,
    });
    requireValue(
      alreadyPublished ||
        !params.requirePublished ||
        deferrals.some((deferred) => deferred.packageName === entry.packageName),
      `${entry.packageName}@${entry.version}: final core publication requires the complete original plugin roster.`,
    );
    if (
      !alreadyPublished &&
      !deferrals.some((deferred) => deferred.packageName === entry.packageName)
    ) {
      pending.push(entry);
    }
  }
  return pending;
}

export async function verifyPreparedNpmRegistry(params) {
  const tarball = readBoundedRegularFile(params.tarballPath, {
    label: "qualified plugin tarball",
    maxBytes: MAX_PACKAGE_BYTES,
  });
  const { distTags } = await verifyNpmRegistryPublication(params, tarball);
  if (distTags) {
    requireNpmDistTagSelection(params, distTags);
  }
  return { alreadyPublished: distTags !== null };
}

// A version this run never published may already be superseded: a later
// release owns the primary selector, so no tag is verified or repaired for it.
export async function verifyPublishedNpmRegistry(params) {
  const { distTags } = await verifyNpmRegistryPublication({
    ...params,
    route: "npm-readback",
    allowMissing: params.allowMissing === true,
  });
  if (distTags === null) {
    return { alreadyPublished: false, supersededBy: null };
  }
  const [primaryTag] = params.publishTags;
  const supersededBy = distTags[primaryTag];
  if (classifyNpmDistTagVersion(supersededBy, params.version) === "ahead") {
    return { alreadyPublished: true, supersededBy };
  }
  requireNpmDistTagSelection(params, distTags);
  return { alreadyPublished: true, supersededBy: null };
}

function requireNpmDistTagSelection(params, distTags) {
  for (const publishTag of params.publishTags) {
    const selectorState = classifyNpmDistTagVersion(distTags[publishTag], params.version);
    if (selectorState !== "match") {
      const message = `${params.packageName}: ${publishTag} differs from the prepared version; use authorized tag repair.`;
      if (selectorState === "missing" || selectorState === "lagging") {
        throw new NpmRegistryUnavailableError(message);
      }
      throw new Error(message);
    }
  }
}

async function verifyNpmRegistryPublication(params, tarball) {
  requireValue(
    PACKAGE.test(params.packageName) && ROUTES.has(params.route),
    "Invalid prepared npm publication request.",
  );
  const deadlineMs = params.allowMissing === true ? undefined : npmRegistryReadbackDeadline();
  const pendingMessage = `${params.packageName}@${params.version}: exact version is not visible yet; verification pending. Retry readback, not publication.`;
  let registry;
  let version;
  for (;;) {
    if (deadlineMs !== undefined && Date.now() >= deadlineMs) {
      throw new NpmRegistryUnavailableError(pendingMessage);
    }
    registry = await fetchNpmRegistryPackumentWithRetry({
      packageName: params.packageName,
      packageUrl: `https://registry.npmjs.org/${encodeURIComponent(params.packageName)}`,
      fetchImpl: params.fetchImpl,
      deadlineMs,
    });
    requireValue(
      registry.status === 404 || registry.ok,
      `npm registry returned HTTP ${registry.status}.`,
    );
    if (registry.ok) {
      requireValue(
        registry.packument?.name === params.packageName &&
          registry.packument.versions &&
          typeof registry.packument.versions === "object" &&
          !Array.isArray(registry.packument.versions) &&
          registry.packument["dist-tags"] &&
          typeof registry.packument["dist-tags"] === "object" &&
          !Array.isArray(registry.packument["dist-tags"]),
        "npm registry response is not an authoritative package inventory.",
      );
    }
    version = registry.packument?.versions?.[params.version];
    if (version) {
      break;
    }
    if (params.allowMissing === true) {
      requireValue(
        registry.status !== 404 || ["npm-token-bootstrap", "npm-readback"].includes(params.route),
        "Prepared OIDC package no longer exists; obtain an explicitly approved bootstrap.",
      );
      return { distTags: null };
    }
    const remainingMs = deadlineMs - Date.now();
    if (remainingMs <= 0) {
      throw new NpmRegistryUnavailableError(pendingMessage);
    }
    console.error(pendingMessage);
    await new Promise((resolveDelay) => {
      setTimeout(resolveDelay, Math.min(10_000, remainingMs));
    });
  }
  requireValue(
    version.name === params.packageName && version.version === params.version,
    "npm registry version identity differs from the requested package.",
  );
  if (tarball) {
    requireValue(
      version.dist?.integrity ===
        `sha512-${createHash("sha512").update(tarball).digest("base64")}` &&
        version.dist?.shasum === createHash("sha1").update(tarball).digest("hex"),
      `${params.packageName}@${params.version}: registry bytes conflict with the qualified artifact.`,
    );
  }
  const url = new URL(version.dist.tarball);
  requireValue(
    url.origin === "https://registry.npmjs.org" && !url.username && !url.password,
    "Prepared npm readback requires the canonical registry tarball URL.",
  );
  const published = await fetchNpmRegistryTarballWithRetry({
    packageName: params.packageName,
    packageUrl: url.href,
    maxBytes: tarball?.length ?? MAX_PACKAGE_BYTES,
    deadlineMs,
    fetchImpl: params.fetchImpl,
  });
  if (tarball) {
    requireValue(
      published.length === tarball.length && sha256(published) === sha256(tarball),
      "Published npm tarball bytes differ from the qualified artifact.",
    );
  } else {
    requireValue(
      version.dist?.integrity ===
        `sha512-${createHash("sha512").update(published).digest("base64")}` &&
        version.dist?.shasum === createHash("sha1").update(published).digest("hex"),
      "Published npm tarball bytes differ from registry integrity.",
    );
    const { packageManifest } = inspectPackageTarballBytes(published);
    requireValue(
      packageManifest.name === params.packageName && packageManifest.version === params.version,
      "Published npm archive package identity differs from the requested version.",
    );
  }
  return { distTags: registry.packument["dist-tags"] };
}

function outputValues(file, values) {
  writeFileSync(
    file,
    `${Object.entries(values)
      .map(([key, value]) => `${key}=${value}`)
      .join("\n")}\n`,
    { flag: "a" },
  );
}

// Each package can run consume and authorize independently. These are enforced
// transport ceilings, including retries, not the happy-path fixture counts.
const PACKAGE_COMMAND_REQUEST_LIMIT = 256;
const PREVIEW_REQUEST_LIMIT = 1024;
const PUBLICATION_REQUEST_HEADROOM = 1024;

async function requireFanoutCapacity(packages, params) {
  if (packages === 0) {
    return;
  }
  accountGithubRequest();
  const response = await (params.fetchImpl ?? fetch)("https://api.github.com/rate_limit", {
    headers: { Authorization: `Bearer ${params.token}`, Accept: "application/vnd.github+json" },
    signal: AbortSignal.timeout(60_000),
  });
  requireValue(response.ok, "GitHub publication request budget could not read current quota.");
  const bytes = await readBoundedResponseBody(response, {
    label: "GitHub rate limit",
    maxBytes: 64 * 1024,
  });
  const { remaining, reset } = JSON.parse(bytes.toString("utf8")).resources?.core ?? {};
  requireValue(
    Number.isSafeInteger(remaining) &&
      remaining >= 0 &&
      Number.isSafeInteger(reset) &&
      reset * 1000 > Date.now(),
    "GitHub publication request budget received invalid or stale quota.",
  );
  const perPackage = 2 * PACKAGE_COMMAND_REQUEST_LIMIT;
  const required = packages * perPackage + PUBLICATION_REQUEST_HEADROOM;
  const maximum = Math.max(0, Math.floor((remaining - PUBLICATION_REQUEST_HEADROOM) / perPackage));
  console.error(
    JSON.stringify({
      githubPublicationBudget: {
        packages,
        perPackage,
        headroom: PUBLICATION_REQUEST_HEADROOM,
        required,
        remaining,
        reset,
      },
    }),
  );
  requireValue(
    required <= remaining,
    `GitHub publication request budget requires ${required} requests for ${packages} packages; ${remaining} remain. Select at most ${maximum} packages or resume after ${new Date(reset * 1000).toISOString()} with fresh parent authorization.`,
  );
}

export async function main(argv) {
  if (!["load", "consume", "authorize"].includes(argv[0])) {
    return runPreparedNpmCommand(argv);
  }
  return withGithubRequestBudget(
    argv[0] === "load" ? PREVIEW_REQUEST_LIMIT : PACKAGE_COMMAND_REQUEST_LIMIT,
    async (budget) => {
      try {
        return await runPreparedNpmCommand(argv);
      } finally {
        console.error(
          JSON.stringify({
            githubRequestAccounting: { scope: "prepared-npm-command", command: argv[0], ...budget },
          }),
        );
      }
    },
  );
}

async function runPreparedNpmCommand(argv) {
  const [command, ...args] = argv;
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    requireValue(
      key?.startsWith("--") && args[index + 1] !== undefined && !Object.hasOwn(options, key),
      "Invalid prepared npm arguments.",
    );
    options[key] = args[index + 1];
  }
  const common = {
    repository: process.env.GITHUB_REPOSITORY,
    workflowSha: process.env.GITHUB_WORKFLOW_SHA ?? process.env.GITHUB_SHA,
    sourceSha: options["--source-sha"],
    npmDistTag: options["--npm-dist-tag"] ?? process.env.PREPARED_NPM_DIST_TAG ?? "default",
    selectionMode: options["--selection-mode"],
    plugins: options["--plugins"] ?? "",
    publisherPolicySha256: options["--policy-file"]
      ? sha256(readFileSync(options["--policy-file"]))
      : undefined,
    token: process.env.GH_TOKEN,
  };
  const capacity =
    command === "load" && options["--report-capacity"] === "true"
      ? createPreparedNpmCapacityObserver()
      : undefined;
  if (capacity) {
    common.fetchImpl = capacity.fetchImpl;
  }
  let adoption;
  let prepared;
  let selectedPackages;
  let writeEvidenceOutput;
  if (["load", "consume", "authorize"].includes(command)) {
    const adoptionParams = {
      ...common,
      selectionMode: common.selectionMode ?? process.env.PREPARED_NPM_SELECTION_MODE,
      plugins: options["--plugins"] ?? process.env.PREPARED_NPM_PLUGINS ?? "",
      artifact: JSON.parse(options["--artifact"] ?? process.env.PREPARED_NPM_ARTIFACT),
      workflowFullRef: process.env.GITHUB_REF,
      fullReleaseValidationRunId: process.env.PREPARED_NPM_FRV_RUN_ID,
      fullReleaseValidationRunAttempt: process.env.PREPARED_NPM_FRV_RUN_ATTEMPT,
    };
    if (options["--evidence-output"] || process.env.PREPARED_NPM_EVIDENCE_ID) {
      const binding = npmEvidenceBinding(adoptionParams);
      const { createReleaseEvidenceClient } = await import("./release-ci-summary.mjs");
      adoptionParams.immutableReads = options["--evidence-output"]
        ? createReleaseEvidenceReplay(binding, undefined, { shareAcquisitionReads: true })
        : await loadNpmEvidenceReplay({
            binding,
            artifactId: process.env.PREPARED_NPM_EVIDENCE_ID,
            artifactDigest: process.env.PREPARED_NPM_EVIDENCE_DIGEST,
            token: common.token,
            archivePath: process.env.RUNNER_TEMP + "/plugin-npm-evidence.zip",
            client: createReleaseEvidenceClient(common.repository),
            shareAcquisitionReads: true,
          });
    }
    adoption = await authenticatePreparedNpmArtifactEvidence(adoptionParams, false);
    if (options["--evidence-output"]) {
      requireValue(command === "load", "Only trusted preview load can write an evidence handoff");
      writeEvidenceOutput = () => {
        const {
          evidenceClient: _client,
          revalidateAuthority: _authority,
          ...preparedEvidence
        } = adoption;
        adoptionParams.immutableReads.setPreparedEvidence(preparedEvidence);
        writeFileSync(options["--evidence-output"], adoptionParams.immutableReads.serialize(), {
          flag: "wx",
        });
      };
    }
    Object.assign(common, {
      workflowSha: adoption.workflowSha,
      publisherPolicySha256: adoption.publisherPolicySha256,
      selectionMode: adoptionParams.selectionMode,
      plugins: adoptionParams.plugins,
      immutableReads: adoptionParams.immutableReads,
    });
    if (command !== "authorize" || options["--package"]) {
      prepared = await downloadPreparedNpmRelease({
        ...common,
        selectionMode: adoption.publicationSelection?.pluginPublishScope ?? common.selectionMode,
        plugins: adoption.publicationSelection?.plugins.join(",") ?? common.plugins,
        // Preview checks the complete frozen source. Sparse publisher jobs instead
        // authenticate that sealed manifest and verify their exact source package.
        sourceRoot: options["--source-root"] ?? (command === "load" ? process.cwd() : undefined),
        artifact: adoption.artifact,
        evidenceClient: adoption.evidenceClient,
        archivePath: options["--archive-path"],
      });
      selectedPackages =
        common.selectionMode === "selected"
          ? prepared.packages.filter((entry) =>
              common.plugins.split(/[,\s]+/u).includes(entry.packageName),
            )
          : prepared.packages;
      if (command !== "load") {
        const entry = JSON.parse(options["--package"]);
        requireValue(
          selectedPackages.some((candidate) => isDeepStrictEqual(candidate, entry)),
          "Prepared npm package differs from the authenticated current operation.",
        );
      }
    }
  }
  if (command === "authorize") {
    await adoption.revalidateAuthority?.();
  } else if (command === "seal") {
    const producer = {
      repository: common.repository,
      runId: Number(process.env.GITHUB_RUN_ID),
      runAttempt: Number(process.env.GITHUB_RUN_ATTEMPT),
      workflowPath: WORKFLOW_PATH,
      workflowEvent: process.env.GITHUB_EVENT_NAME,
      workflowHeadBranch: process.env.GITHUB_REF_NAME,
      workflowSha: common.workflowSha,
    };
    const manifest = createPreparedNpmRelease({
      ...common,
      producer,
      matrix: JSON.parse(process.env.PLUGIN_MATRIX),
      artifacts: readJson(options["--artifacts-file"], 4 * MAX_MANIFEST_BYTES).artifacts,
      workflowRun: readJson(options["--run-file"]),
      workflowJobs: readJson(options["--jobs-file"], 4 * MAX_MANIFEST_BYTES),
    });
    mkdirSync(options["--output-dir"], { recursive: true });
    writeFileSync(
      join(options["--output-dir"], PREPARED_NPM_MANIFEST),
      `${JSON.stringify(manifest)}\n`,
    );
    outputValues(options["--github-output"], {
      artifact_name: preparedNpmArtifactName(common.sourceSha, producer),
    });
  } else if (command === "load") {
    const requirePublished = options["--require-published"] === "true";
    const prunePublished = options["--prune-published"] === "true";
    requireValue(
      !requirePublished ||
        (common.selectionMode === "all-publishable" &&
          adoption.publicationOperation?.publishOpenclawNpm),
      "Final npm roster verification requires the original all-package core operation.",
    );
    let corePluginDeferrals = [];
    const parentRunId =
      process.env.PREPARED_NPM_PARENT_RUN_ID ||
      (options["--core-deferral-parent"] === "true" ? process.env.GITHUB_RUN_ID : "");
    // Only beta roster selection can apply deferrals; plain evidence loads cannot.
    if (
      parentRunId &&
      adoption.publicationSelection?.npmDistTag === "beta" &&
      common.selectionMode === "all-publishable" &&
      (prunePublished || requirePublished)
    ) {
      const { receipt } = await downloadReleaseApprovalReceipt({
        token: common.token,
        expected: {
          repository: common.repository,
          parentRunId,
          parentRunAttempt:
            process.env.PREPARED_NPM_PARENT_RUN_ATTEMPT || process.env.GITHUB_RUN_ATTEMPT,
          toolingRef: process.env.GITHUB_REF_NAME,
          toolingFullRef: process.env.GITHUB_REF,
          toolingSha: process.env.GITHUB_WORKFLOW_SHA ?? process.env.GITHUB_SHA,
          targetSha: common.sourceSha,
        },
      });
      corePluginDeferrals = receipt.corePluginDeferrals ?? [];
    }
    const matrix =
      prunePublished || requirePublished
        ? await selectUnpublishedPreparedNpmPackages({
            ...common,
            fetchImpl: capacity?.packageFetchImpl ?? common.fetchImpl,
            packages: selectedPackages,
            sourceRoot: options["--source-root"] ?? process.cwd(),
            cacheDir: options["--cache-dir"],
            outputDir: options["--output-dir"],
            requirePublished,
            corePluginDeferrals,
          })
        : selectedPackages;
    await requireFanoutCapacity(matrix.length, common);
    await adoption.revalidateAuthority?.();
    capacity?.report(selectedPackages.length);
    writeEvidenceOutput?.();
    writeFileSync(options["--output"], JSON.stringify(prepared));
    outputValues(options["--github-output"], {
      has_candidates: matrix.length > 0,
      has_selection: matrix.length > 0,
      candidate_count: matrix.length,
      selection_count: matrix.length,
      matrix: JSON.stringify(matrix),
      all_matrix: JSON.stringify(selectedPackages),
      core_deferrals: JSON.stringify(corePluginDeferrals),
    });
  } else if (command === "consume") {
    const entry = JSON.parse(options["--package"]);
    const result = await consumePreparedNpmPackage({
      ...common,
      package: entry,
      sourcePackageJson: options["--source-package-json"],
      cacheDir: options["--cache-dir"],
      outputDir: options["--output-dir"],
      verificationOutput: options["--verification-output"],
    });
    await adoption.revalidateAuthority?.();
    outputValues(options["--github-output"], {
      package_name: result.manifest.package.name,
      package_version: result.manifest.package.version,
      publish_route: result.manifest.publication.route,
      publish_tag: result.manifest.publication.tag,
      tarball_path: result.tarballPath,
      tarball_sha256: result.tarballSha256,
    });
  } else if (command === "registry") {
    let result;
    try {
      result = await verifyPreparedNpmRegistry({
        packageName: options["--package-name"],
        version: options["--version"],
        publishTags: [options["--publish-tag"]],
        route: options["--route"],
        tarballPath: options["--tarball"],
        allowMissing: options["--allow-missing"] === "true",
      });
    } catch (error) {
      // Only an accepted publish with a parent verifier may defer unavailable
      // reads. Conflicting bytes/identity and unsafe selectors remain hard failures.
      if (
        options["--defer-visibility"] !== "true" ||
        options["--allow-missing"] !== "false" ||
        options["--route"] === "npm-readback" ||
        !(error instanceof NpmRegistryUnavailableError)
      ) {
        throw error;
      }
      const message = `${options["--package-name"]}@${options["--version"]}: published, visibility pending; the parent's final registry verification must pass before release completion. Do not republish.`;
      console.warn(`::warning::${message}`);
      if (process.env.GITHUB_STEP_SUMMARY) {
        writeFileSync(process.env.GITHUB_STEP_SUMMARY, `- ${message}\n`, { flag: "a" });
      }
      return;
    }
    if (options["--github-output"]) {
      outputValues(options["--github-output"], { already_published: result.alreadyPublished });
    }
    console.log(
      `${options["--package-name"]}@${options["--version"]}: ${result.alreadyPublished ? "verified exact published bytes and selector" : "qualified artifact ready for publication"}`,
    );
  } else {
    throw new Error(
      "Usage: plugin-npm-prepared-release.mjs <seal|load|consume|authorize|registry> [options]",
    );
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  // Let this module finish evaluating before a lazy import cycles back to it.
  void main(process.argv.slice(2)).catch((/** @type {unknown} */ error) => {
    console.error(error instanceof Error ? error.message : String(error));
    console.error("[plugin-npm-prepared-release] FAILED (exit 1)");
    process.exitCode = 1;
  });
}
