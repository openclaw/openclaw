import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
import { runReleaseToolingGh } from "./release-tooling-identity.mjs";

const WORKFLOW = ".github/workflows/plugin-npm-release.yml";
const JOB_PREFIX = "Publish plugin npm package (";
const SHA = /^[a-f0-9]{40}$/u;
const RECEIPT_BYTES = 256 * 1024;

function requireValue(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
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
  const api = (endpoint) => JSON.parse(runGh(["api", `repos/${repository}/${endpoint}`]));
  const inventory = (endpoint, key) => {
    const fields =
      key === "jobs"
        ? "id,name,run_id,run_attempt,head_sha,status,conclusion,steps"
        : "id,name,digest,size_in_bytes,expired,expires_at,workflow_run";
    const raw = runGh([
      "api",
      `repos/${repository}/${endpoint}${endpoint.includes("?") ? "&" : "?"}per_page=100`,
      "--paginate",
      "--jq",
      `{total_count, ${key}: [.${key}[] | {${fields}}]} | @json`,
    ]);
    const pages = raw
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const count = pages[0]?.total_count;
    requireValue(
      Number.isSafeInteger(count) &&
        count >= 0 &&
        count <= 10_000 &&
        pages.every((page) => page.total_count === count && Array.isArray(page[key])),
      `Incomplete plugin npm ${key} inventory.`,
    );
    const entries = pages.flatMap((page) => page[key]);
    requireValue(
      entries.length === count && new Set(entries.map((entry) => entry.id)).size === count,
      `Incomplete or duplicate plugin npm ${key} inventory.`,
    );
    return entries;
  };
  const run = api(`actions/runs/${runId}`);
  requireValue(
    run.id === runId &&
      Number.isSafeInteger(run.run_attempt) &&
      run.run_attempt > 0 &&
      run.path === WORKFLOW &&
      run.event === "workflow_dispatch" &&
      run.head_sha === workflowSha &&
      run.head_branch === workflowRef &&
      run.repository?.full_name === repository &&
      run.head_repository?.full_name === repository &&
      run.status === "completed" &&
      run.conclusion === "success",
    "Plugin npm readback child identity or successful attempt does not match publication.",
  );
  const jobs = inventory(`actions/runs/${runId}/jobs?filter=all`, "jobs");
  const artifacts = inventory(`actions/runs/${runId}/artifacts`, "artifacts");
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
  const attempt = (id, number) => {
    const key = `${id}/${number}`;
    if (!attempts.has(key)) {
      attempts.set(key, api(`actions/runs/${id}/attempts/${number}`));
    }
    return attempts.get(key);
  };
  const download = async (binding, metadata, producerRun, maxArchiveBytes) => {
    validateActionsArtifactBinding({
      expected: binding,
      artifactMetadata: metadata,
      workflowRun: producerRun,
    });
    let workflowJobs;
    if (binding.runStatePolicy === "same-run-producer-success") {
      const key = `${binding.runId}/${binding.runAttempt}`;
      // Prior attempts are terminal; reuse their complete inventory across packages.
      if (!jobInventories.has(key)) {
        const producerJobs = inventory(
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
  // Failed-job reruns retain the successful planner from its original attempt.
  // Its resolved matrix, not absent publisher jobs, owns the skip disposition.
  const { value: plan, metadata: planMetadata } = await readJobReceipt(
    planner,
    `plugin-npm-plan-${runId}-${planner.run_attempt}`,
    "npm-publication-plan.json",
  );
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
      JSON.stringify(identities([...plan.candidates, ...plan.skippedPublished])) ===
        JSON.stringify(identities(packages)),
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
    async verify(packageName, releaseVersion, releaseDistTag) {
      const entry = byJob.get(`${JOB_PREFIX}${packageName})`);
      requireValue(
        entry?.version === releaseVersion,
        "Qualified plugin version differs from the parent release version.",
      );
      const job = publishers.get(`${JOB_PREFIX}${packageName})`);
      if (!job) {
        requireValue(
          skipped.has(packageName),
          "Plugin npm package has no recorded publication disposition.",
        );
        // A prior parent may have published successfully and then failed before
        // final readback. A new plan's skip never proves registry visibility.
        await verifyPublishedNpmRegistry({
          packageName,
          version: releaseVersion,
          publishTags: [releaseDistTag],
          fetchImpl: options.fetchImpl,
        });
        evidence.push({
          packageName,
          verification: "published-registry",
          childRunId: runId,
          planAttempt: planner.run_attempt,
          planArtifactId: planMetadata.id,
        });
        return;
      }
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
          receipt.workflowSha === workflowSha &&
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
        workflowSha,
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
      const qualifiedRun = attempt(receipt.runId, receipt.runAttempt);
      const qualifiedMetadata = api(`actions/artifacts/${receipt.artifactId}`);
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
              readFileSync(new URL("../.github/workflows/plugin-npm-release.yml", import.meta.url)),
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
      await verifyPreparedNpmRegistry({
        packageName,
        version: entry.version,
        route: receipt.route,
        publishTags: [...new Set([receipt.publishTag, releaseDistTag])],
        tarballPath: consumed.tarballPath,
        allowMissing: false,
        fetchImpl: options.fetchImpl,
      });
      evidence.push({
        packageName,
        verification: "qualified-artifact",
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
      });
    },
  };
}
