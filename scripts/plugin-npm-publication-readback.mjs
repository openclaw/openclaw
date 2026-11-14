import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  classifyReleaseGhTransportError,
  releaseGhRateLimitRetryAt,
} from "./full-release-validation-policy.mjs";
import {
  downloadExactActionsArtifactArchive,
  inspectActionsArtifactZipWithPolicy,
  readBoundedRegularFile,
  validateActionsArtifactBinding,
  validateActionsArtifactProducerJob,
} from "./lib/actions-artifact-archive.mjs";
import { collectPublishablePluginPackages } from "./lib/plugin-npm-release.ts";
import { isRecord } from "./lib/record-shared.mjs";
import {
  verifyPreparedNpmRegistry,
  verifyPublishedNpmRegistry,
} from "./plugin-npm-prepared-release.mjs";
import { verifyPluginPublicationArtifact } from "./plugin-publication-artifact.mjs";
import { parseGithubResponse } from "./pr-lib/gh-api-preflight.mjs";
import { validateCorePluginDeferrals } from "./release-approval-receipt.mjs";
import { runReleaseToolingGh } from "./release-tooling-identity.mjs";

const WORKFLOW = ".github/workflows/plugin-npm-release.yml";
const JOB_PREFIX = "Publish plugin npm package (";
const SHA = /^[a-f0-9]{40}$/u;
const RECEIPT_BYTES = 256 * 1024;
const READ_ATTEMPTS = 3;
const READ_DEADLINE_MS = 3 * 60_000;

function requireValue(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

export async function retryPluginNpmRead(read, options = {}) {
  const attempts = options.attempts ?? READ_ATTEMPTS;
  requireValue(
    Number.isSafeInteger(attempts) && attempts > 0 && attempts <= 5,
    "Plugin npm read retry count is invalid.",
  );
  const now = options.now ?? Date.now;
  const deadlineMs = options.deadlineMs ?? now() + READ_DEADLINE_MS;
  const delay =
    options.delay ??
    ((delayMs) =>
      new Promise((resolveDelay) => {
        setTimeout(resolveDelay, delayMs);
      }));

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      // The callback owns parsing and identity validation, so every successful
      // retry is checked before any later read can consume it.
      return await read();
    } catch (error) {
      if (classifyReleaseGhTransportError(error) !== "transient" || attempt === attempts) {
        throw error;
      }
      const currentTime = now();
      const retryAt = releaseGhRateLimitRetryAt(error, currentTime, attempt - 1);
      const delayMs = Math.max(attempt * 1000, retryAt === undefined ? 0 : retryAt - currentTime);
      if (delayMs >= deadlineMs - currentTime) {
        throw error;
      }
      await delay(delayMs);
    }
  }
  throw new Error("Plugin npm read retry exhausted unexpectedly.");
}

export async function createPluginNpmPublicationReadback(options) {
  const { repository, runId, sourceSha, workflowSha, workflowRef, sourceRoot, cacheDir } = options;
  requireValue(
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository) &&
      Number.isSafeInteger(runId) &&
      runId > 0 &&
      SHA.test(sourceSha) &&
      SHA.test(workflowSha) &&
      typeof workflowRef === "string" &&
      workflowRef.length > 0,
    "Plugin npm parent readback requires the exact source, tooling, and child run.",
  );
  const runGh = options.runGh ?? runReleaseToolingGh;
  const readApi = (endpoint, jq) => {
    const raw = runGh([
      "api",
      `repos/${repository}/${endpoint}`,
      ...(jq ? ["--jq", jq] : []),
      "--include",
    ]);
    const response = parseGithubResponse(raw);
    requireValue(
      /^2\d\d$/u.test(response.status ?? "") &&
        response.body !== null &&
        typeof response.body === "object" &&
        !Array.isArray(response.body),
      "Plugin npm GitHub read returned an invalid response.",
    );
    return response.body;
  };
  const api = (endpoint, validate = (value) => value) =>
    retryPluginNpmRead(() => {
      const value = readApi(endpoint);
      return validate(value);
    });
  const inventory = (endpoint, key) =>
    retryPluginNpmRead(() => {
      const fields =
        key === "jobs"
          ? "id,name,run_id,run_attempt,head_sha,status,conclusion,steps"
          : "id,name,digest,size_in_bytes,expired,expires_at,workflow_run";
      const entries = [];
      let count;
      for (let page = 1; page <= 100; page += 1) {
        const value = readApi(
          `${endpoint}${endpoint.includes("?") ? "&" : "?"}per_page=100&page=${page}`,
          `{total_count, ${key}: [.${key}[] | {${fields}}]}`,
        );
        if (count === undefined) {
          count = value.total_count;
        }
        requireValue(
          Number.isSafeInteger(count) &&
            count >= 0 &&
            count <= 10_000 &&
            value.total_count === count &&
            Array.isArray(value[key]),
          `Incomplete plugin npm ${key} inventory.`,
        );
        entries.push(...value[key]);
        if (entries.length >= count) {
          break;
        }
        requireValue(value[key].length === 100, `Incomplete plugin npm ${key} inventory.`);
      }
      requireValue(
        entries.length === count && new Set(entries.map((entry) => entry.id)).size === count,
        `Incomplete or duplicate plugin npm ${key} inventory.`,
      );
      return entries;
    });
  const run = await api(`actions/runs/${runId}`, (value) => {
    requireValue(
      value.id === runId &&
        Number.isSafeInteger(value.run_attempt) &&
        value.run_attempt > 0 &&
        value.path === WORKFLOW &&
        value.event === "workflow_dispatch" &&
        value.head_sha === workflowSha &&
        value.head_branch === workflowRef &&
        value.repository?.full_name === repository &&
        value.head_repository?.full_name === repository &&
        value.status === "completed" &&
        value.conclusion === "success",
      "Plugin npm readback child identity or successful attempt does not match publication.",
    );
    return value;
  });
  const jobs = await inventory(`actions/runs/${runId}/jobs?filter=all`, "jobs");
  const artifacts = await inventory(`actions/runs/${runId}/artifacts`, "artifacts");
  const packages = collectPublishablePluginPackages(sourceRoot, {
    packageNames: options.plugins?.length > 0 ? options.plugins : undefined,
  });
  const byJob = new Map(packages.map((entry) => [`${JOB_PREFIX}${entry.packageName})`, entry]));
  const publishers = new Map();
  for (const job of jobs) {
    if (!job.name?.startsWith(JOB_PREFIX) || job.conclusion === "skipped") {
      continue;
    }
    requireValue(
      byJob.has(job.name) &&
        job.run_id === runId &&
        job.head_sha === workflowSha &&
        Number.isSafeInteger(job.run_attempt) &&
        job.run_attempt > 0 &&
        job.run_attempt <= run.run_attempt,
      "Plugin npm publisher job does not match the frozen package roster or child identity.",
    );
    const previous = publishers.get(job.name);
    requireValue(previous?.run_attempt !== job.run_attempt, "Ambiguous plugin npm publisher job.");
    if (!previous || previous.run_attempt < job.run_attempt) {
      publishers.set(job.name, job);
    }
  }
  const planners = jobs.filter((job) => job.name === "preview_plugins_npm");
  const planner = planners.toSorted((left, right) => right.run_attempt - left.run_attempt)[0];
  requireValue(
    planner &&
      planner.run_id === runId &&
      planner.head_sha === workflowSha &&
      planner.status === "completed" &&
      planner.conclusion === "success" &&
      Number.isSafeInteger(planner.run_attempt) &&
      planner.run_attempt > 0 &&
      planner.run_attempt <= run.run_attempt &&
      planners.filter((job) => job.run_attempt === planner.run_attempt).length === 1,
    "Plugin npm child has no unambiguous successful planning job.",
  );
  mkdirSync(cacheDir, { recursive: true });
  const attempts = new Map([[`${runId}/${run.run_attempt}`, run]]);
  const jobInventories = new Map();
  const attempt = async (id, number) => {
    const key = `${id}/${number}`;
    if (!attempts.has(key)) {
      attempts.set(key, api(`actions/runs/${id}/attempts/${number}`));
    }
    return await attempts.get(key);
  };
  const download = async (binding, metadata, producerRun, maxArchiveBytes) => {
    const resolvedProducerRun = await producerRun;
    validateActionsArtifactBinding({
      expected: binding,
      artifactMetadata: metadata,
      workflowRun: resolvedProducerRun,
    });
    let workflowJobs;
    if (binding.runStatePolicy === "same-run-producer-success") {
      const key = `${binding.runId}/${binding.runAttempt}`;
      // Prior attempts are terminal; reuse their complete inventory across packages.
      if (!jobInventories.has(key)) {
        const producerJobs = await inventory(
          `actions/runs/${binding.runId}/attempts/${binding.runAttempt}/jobs`,
          "jobs",
        );
        jobInventories.set(key, { total_count: producerJobs.length, jobs: producerJobs });
      }
      workflowJobs = jobInventories.get(key);
    }
    if (workflowJobs) {
      validateActionsArtifactProducerJob({ expected: binding, workflowJobs });
    }
    const archivePath = join(cacheDir, `${binding.artifactId}.zip`);
    const downloaded = await downloadExactActionsArtifactArchive({
      expected: { ...binding, artifactExpiresAt: metadata.expires_at },
      archivePath,
      token: options.token,
      fetchImpl: options.fetchImpl,
      maxArchiveBytes,
    });
    return { ...downloaded, archivePath, workflowJobs };
  };
  const readJobReceipt = async (job, name, file) => {
    const matches = artifacts.filter(
      (artifact) => artifact.name === name && artifact.expired === false,
    );
    requireValue(matches.length === 1, `Expected one consumed npm qualification receipt: ${name}.`);
    const metadata = matches[0];
    const receiptBinding = {
      repository,
      workflowPath: WORKFLOW,
      workflowEvent: "workflow_dispatch",
      workflowSha,
      workflowHeadBranch: workflowRef,
      runId,
      runAttempt: job.run_attempt,
      runStatePolicy:
        job.run_attempt === run.run_attempt ? "completed-success" : "same-run-producer-success",
      consumerRunAttempt: run.run_attempt,
      producerJobName: job.name,
      ...(job.conclusion === "failure"
        ? { producerStepName: "Upload consumed npm qualification" }
        : {}),
      artifactId: metadata.id,
      artifactName: name,
      artifactDigest: metadata.digest,
      artifactSizeBytes: metadata.size_in_bytes,
    };
    const receiptArchive = await download(
      receiptBinding,
      metadata,
      attempt(runId, job.run_attempt),
      RECEIPT_BYTES,
    );
    const files = inspectActionsArtifactZipWithPolicy(receiptArchive.archiveBytes, {
      expectedEntries: [file],
      maxArchiveBytes: RECEIPT_BYTES,
      maxExpandedBytes: RECEIPT_BYTES,
      maxEntryBytes: () => RECEIPT_BYTES,
    });
    return { value: JSON.parse(files.get(file).toString("utf8")), metadata };
  };
  const readDeferredAuthCheckpoint = async (job, entry, releaseDistTag) => {
    const artifactName = `plugin-npm-deferred-auth-${entry.extensionId}-${runId}-${job.run_attempt}`;
    const matches = artifacts.filter(
      (artifact) => artifact.name === artifactName && artifact.expired === false,
    );
    requireValue(
      matches.length <= 1,
      `Ambiguous deferred npm authentication checkpoint: ${artifactName}.`,
    );
    if (matches.length === 0) {
      return undefined;
    }
    const { value: checkpoint, metadata } = await readJobReceipt(
      job,
      artifactName,
      `${entry.extensionId}-npm-oidc-deferred.json`,
    );
    const workflowRefMatches =
      checkpoint?.workflow?.ref === `refs/heads/${workflowRef}` ||
      checkpoint?.workflow?.ref === `refs/tags/${workflowRef}`;
    requireValue(
      isRecord(checkpoint) &&
        checkpoint.schemaVersion === 1 &&
        checkpoint.kind === "openclaw-plugin-npm-deferred-auth" &&
        checkpoint.reason === "npm-oidc-eneedauth" &&
        checkpoint.repository === repository &&
        isRecord(checkpoint.workflow) &&
        workflowRefMatches &&
        checkpoint.workflow.sha === workflowSha &&
        checkpoint.workflow.runId === runId &&
        checkpoint.workflow.runAttempt === job.run_attempt &&
        isRecord(checkpoint.parent) &&
        checkpoint.parent.runId === options.parentRunId &&
        checkpoint.parent.runAttempt === options.parentRunAttempt &&
        checkpoint.sourceSha === sourceSha &&
        isRecord(checkpoint.package) &&
        checkpoint.package.extensionId === entry.extensionId &&
        checkpoint.package.name === entry.packageName &&
        checkpoint.package.version === entry.version &&
        checkpoint.package.publishTag === releaseDistTag &&
        releaseDistTag !== "extended-stable" &&
        isRecord(checkpoint.recovery) &&
        checkpoint.recovery.environment === "npm-publish" &&
        checkpoint.recovery.publishScope === "selected" &&
        checkpoint.recovery.requiresParentPublication === false &&
        checkpoint.recovery.requiresTrustedPublisherPreflight === true,
      "Deferred npm authentication checkpoint differs from the approved parent, source, or package.",
    );
    return { checkpoint, metadata };
  };
  // Failed-job reruns retain the successful planner from its original attempt.
  // Its resolved matrix, not absent publisher jobs, owns the skip disposition.
  const { value: plan, metadata: planMetadata } = await readJobReceipt(
    planner,
    `plugin-npm-plan-${runId}-${planner.run_attempt}`,
    "npm-publication-plan.json",
  );
  // The exact trusted planner verifies the complete qualified roster and reads
  // these declarations from its live, human-approved parent receipt. They are
  // distinct from both published skips and automatic ENEEDAUTH checkpoints.
  const coreDeferrals = plan.coreDeferrals?.length
    ? validateCorePluginDeferrals(plan.coreDeferrals, {
        targetSha: sourceSha,
        releaseTag: `v${packages[0]?.version}`,
        npmDistTag: options.npmDistTag ?? "beta",
      })
    : [];
  const deferredPackages = coreDeferrals.map((deferred) => {
    const entry = packages.find((candidate) => candidate.packageName === deferred.packageName);
    requireValue(entry, "Deferred npm package is outside the frozen roster.");
    return entry;
  });
  const identities = (entries) => {
    requireValue(Array.isArray(entries) && entries.length <= 256, "Invalid npm planning roster.");
    const values = entries.map((entry) =>
      JSON.stringify([entry.packageName, entry.packageDir, entry.version]),
    );
    requireValue(new Set(values).size === values.length, "Duplicate npm planning roster entry.");
    return values.toSorted();
  };
  requireValue(
    plan.sourceSha === sourceSha &&
      JSON.stringify(identities(plan.all)) === JSON.stringify(identities(packages)) &&
      JSON.stringify(
        identities([...plan.candidates, ...plan.skippedPublished, ...deferredPackages]),
      ) === JSON.stringify(identities(packages)),
    "Resolved npm publication plan differs from the frozen package roster.",
  );
  requireValue(
    plan.candidates.every((entry) => publishers.has(`${JOB_PREFIX}${entry.packageName})`)),
    "Plugin npm planned candidate has no successful publisher job.",
  );
  const skipped = new Set(plan.skippedPublished.map((entry) => entry.packageName));
  for (const job of publishers.values()) {
    const skippedAfterFailure =
      job.conclusion === "failure" &&
      job.run_attempt < planner.run_attempt &&
      skipped.has(byJob.get(job.name).packageName);
    requireValue(
      job.status === "completed" && (job.conclusion === "success" || skippedAfterFailure),
      "Plugin npm publisher job did not complete successfully or precede its verified skipped plan.",
    );
  }
  const evidence = [];
  return {
    evidence,
    /**
     * @returns {Promise<{ disposition: "published" | "deferred-auth"; note?: string }>}
     */
    async verify(packageName, releaseVersion, releaseDistTag) {
      const entry = byJob.get(`${JOB_PREFIX}${packageName})`);
      requireValue(
        entry?.version === releaseVersion,
        "Qualified plugin version differs from the parent release version.",
      );
      const job = publishers.get(`${JOB_PREFIX}${packageName})`);
      const coreDeferral = coreDeferrals.find((deferred) => deferred.packageName === packageName);
      if (coreDeferral) {
        requireValue(!job, "Explicitly deferred package unexpectedly has a publisher job.");
        const { alreadyPublished, supersededBy } = await verifyPublishedNpmRegistry({
          packageName,
          version: releaseVersion,
          publishTags: [releaseDistTag],
          allowMissing: true,
          fetchImpl: options.fetchImpl,
        });
        evidence.push({
          ...coreDeferral,
          verification: alreadyPublished ? "published-registry" : "operator-deferred-auth",
          supersededBy,
          childRunId: runId,
          planAttempt: planner.run_attempt,
          planArtifactId: planMetadata.id,
        });
        return {
          disposition: alreadyPublished ? "published" : "deferred-auth",
          note: alreadyPublished
            ? `${packageName}@${releaseVersion} is public after its explicit deferral; original failure ${coreDeferral.evidence}.`
            : `${packageName}@${releaseVersion} explicitly deferred: ${coreDeferral.reason}; original failure ${coreDeferral.evidence}. Publication is not asserted.`,
        };
      }
      if (!job) {
        requireValue(
          skipped.has(packageName),
          "Plugin npm package has no recorded publication disposition.",
        );
        // A prior parent may have published successfully and then failed before
        // final readback. A new plan's skip never proves registry visibility.
        const { supersededBy } = await verifyPublishedNpmRegistry({
          packageName,
          version: releaseVersion,
          publishTags: [releaseDistTag],
          fetchImpl: options.fetchImpl,
        });
        evidence.push({
          packageName,
          verification: "published-registry",
          supersededBy,
          childRunId: runId,
          planAttempt: planner.run_attempt,
          planArtifactId: planMetadata.id,
        });
        return {
          disposition: "published",
          ...(supersededBy === null
            ? {}
            : {
                note: `${packageName}@${releaseVersion} superseded by ${supersededBy}; dist-tag ${releaseDistTag} stays.`,
              }),
        };
      }
      const deferredAuth = await readDeferredAuthCheckpoint(job, entry, releaseDistTag);
      const { value: receipt, metadata } = await readJobReceipt(
        job,
        `plugin-npm-qualification-${entry.extensionId}-${runId}-${job.run_attempt}`,
        `${entry.extensionId}-npm-qualification.json`,
      );
      requireValue(
        isRecord(receipt) &&
          receipt.repository === repository &&
          receipt.workflowPath === WORKFLOW &&
          Number.isSafeInteger(receipt.runId) &&
          receipt.runId > 0 &&
          Number.isSafeInteger(receipt.runAttempt) &&
          receipt.runAttempt > 0 &&
          Number.isSafeInteger(receipt.artifactId) &&
          receipt.artifactId > 0 &&
          receipt.workflowEvent === "workflow_dispatch" &&
          (receipt.workflowSha === workflowSha ||
            (receipt.runId !== runId && receipt.workflowSha === sourceSha)) &&
          receipt.targetSha === sourceSha &&
          receipt.packageName === packageName &&
          receipt.packageDir === entry.packageDir &&
          receipt.version === entry.version &&
          ["npm-oidc", "npm-token-bootstrap", "npm-readback"].includes(receipt.route),
        "Consumed plugin npm qualification differs from the approved package or source.",
      );
      const retained = receipt.runId === runId;
      requireValue(
        retained
          ? receipt.runStatePolicy === "same-run-producer-success" &&
              receipt.consumerRunAttempt === job.run_attempt &&
              receipt.runAttempt <= job.run_attempt &&
              receipt.producerJobName === `Preflight plugin npm package (${packageName})`
          : receipt.runStatePolicy === "completed-success",
        "Consumed plugin npm qualification lost its producer-attempt binding.",
      );
      const qualifiedBinding = {
        repository,
        workflowPath: WORKFLOW,
        workflowEvent: "workflow_dispatch",
        workflowSha: receipt.workflowSha,
        workflowHeadBranch: receipt.workflowHeadBranch,
        runId: receipt.runId,
        runAttempt: receipt.runAttempt,
        artifactId: receipt.artifactId,
        artifactName: receipt.artifactName,
        artifactDigest: receipt.artifactDigest,
        artifactSizeBytes: receipt.artifactSizeBytes,
        // A current qualification was checked while its publisher was active;
        // the completed child now supplies the stronger terminal-success proof.
        runStatePolicy:
          retained && receipt.runAttempt < run.run_attempt
            ? "same-run-producer-success"
            : "completed-success",
        consumerRunAttempt: run.run_attempt,
        producerJobName: receipt.producerJobName,
      };
      const qualifiedRun = await attempt(receipt.runId, receipt.runAttempt);
      const qualifiedMetadata = await api(`actions/artifacts/${receipt.artifactId}`, (value) => {
        validateActionsArtifactBinding({
          expected: qualifiedBinding,
          artifactMetadata: value,
          workflowRun: qualifiedRun,
        });
        return value;
      });
      const qualified = await download(qualifiedBinding, qualifiedMetadata, qualifiedRun);
      const directory = mkdtempSync(join(cacheDir, "qualified-"));
      const metadataPath = join(directory, "artifact.json");
      const runPath = join(directory, "run.json");
      const jobsPath = join(directory, "jobs.json");
      writeFileSync(metadataPath, JSON.stringify(qualifiedMetadata));
      writeFileSync(runPath, JSON.stringify(qualifiedRun));
      if (qualified.workflowJobs) {
        writeFileSync(jobsPath, JSON.stringify(qualified.workflowJobs));
      }
      const consumed = verifyPluginPublicationArtifact({
        ...qualifiedBinding,
        packageDir: entry.packageDir,
        packageName,
        version: entry.version,
        targetSha: sourceSha,
        route: receipt.route,
        publishTag: receipt.publishTag,
        publicationReason: receipt.publicationReason,
        publisherPolicy: {
          schema: "openclaw.plugin-npm-publisher-policy/v1",
          policyId: "plugin-npm-release-workflow",
          sha256: createHash("sha256")
            .update(
              // The authenticated P receipt records the original producer, not
              // a new publication authority. Q's archive retains Q's policy.
              receipt.workflowSha === workflowSha
                ? readFileSync(
                    new URL("../.github/workflows/plugin-npm-release.yml", import.meta.url),
                  )
                : readBoundedRegularFile(join(sourceRoot, WORKFLOW), {
                    label: "frozen source npm publisher policy",
                    maxBytes: 1024 * 1024,
                  }),
            )
            .digest("hex"),
        },
        sourcePackageJsonSha256: createHash("sha256")
          .update(
            readBoundedRegularFile(join(sourceRoot, entry.packageDir, "package.json"), {
              label: "frozen source package.json",
              maxBytes: 1024 * 1024,
            }),
          )
          .digest("hex"),
        artifactMetadataPath: metadataPath,
        workflowRunMetadataPath: runPath,
        workflowJobsMetadataPath: jobsPath,
        artifactZipPath: qualified.archivePath,
        outputDir: join(directory, "package"),
      });
      if (!deferredAuth) {
        await verifyPreparedNpmRegistry({
          packageName,
          version: entry.version,
          route: receipt.route,
          publishTags: [...new Set([receipt.publishTag, releaseDistTag])],
          tarballPath: consumed.tarballPath,
          allowMissing: false,
          fetchImpl: options.fetchImpl,
        });
      }
      evidence.push({
        packageName,
        verification: deferredAuth ? "deferred-auth" : "qualified-artifact",
        sourceSha,
        workflowSha,
        childRunId: runId,
        childRunAttempt: run.run_attempt,
        publisherAttempt: job.run_attempt,
        planAttempt: planner.run_attempt,
        planArtifactId: planMetadata.id,
        receiptArtifactId: metadata.id,
        receiptArtifactDigest: metadata.digest,
        producerRunId: receipt.runId,
        producerRunAttempt: receipt.runAttempt,
        artifactId: receipt.artifactId,
        artifactDigest: receipt.artifactDigest,
        tarballSha256: consumed.tarballSha256,
        ...(deferredAuth
          ? {
              deferredAuthArtifactId: deferredAuth.metadata.id,
              deferredAuthArtifactDigest: deferredAuth.metadata.digest,
              recovery: deferredAuth.checkpoint.recovery,
            }
          : {}),
      });
      return deferredAuth
        ? {
            disposition: "deferred-auth",
            note: `${packageName}@${releaseVersion} deferred after npm ENEEDAUTH; selected-package recovery is required.`,
          }
        : { disposition: "published" };
    },
  };
}
