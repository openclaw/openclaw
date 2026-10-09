#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  downloadClawHubTransactions,
  readPackedClawHubTransaction,
  validateClawHubParentAuthorization,
  validateClawHubIdentity,
  validateClawHubWorkflowRun,
} from "./clawhub-parent-authorization.mjs";
import {
  downloadExactActionsArtifactArchive,
  inspectActionsArtifactZip,
  readBoundedRegularFile,
  validateActionsArtifactBinding,
  validateActionsArtifactProducerJob,
} from "./lib/actions-artifact-archive.mjs";
import { readBoundedResponseText } from "./lib/bounded-response.mjs";
import { waitForClawHubPublicVersion } from "./lib/clawhub-publication-state.mjs";
import { validateClawHubRecoveryManifest } from "./plugin-clawhub-recovery.mjs";
import { verifyReleaseToolingIdentity } from "./release-tooling-identity.mjs";
import { verifyPublishedClawHubPackage } from "./verify-clawhub-published-artifact.mjs";

const REPOSITORY = "openclaw/openclaw";
const PARENT_WORKFLOW = ".github/workflows/openclaw-release-publish.yml";
const CHILD_WORKFLOW = ".github/workflows/plugin-clawhub-release.yml";
const MAX_RECEIPT_BYTES = 64 * 1024;
const DISPATCH_JOBS = new Set(["Publish plugins, then OpenClaw", "record_docker_only_scope"]);
const DISPATCH_UPLOAD_STEP = "Upload exact release child dispatch record";
const MAX_DISPATCH_RECORDS = 32;

function positiveId(value, label) {
  if (!/^[1-9][0-9]*$/u.test(String(value)) || !Number.isSafeInteger(Number(value))) {
    throw new Error(`${label} must be a positive safe integer.`);
  }
  return Number(value);
}

function requireRun(run, expected, statePolicy = "completed-success") {
  const actual = {
    repository: run?.repository?.full_name,
    headRepository: run?.head_repository?.full_name,
    workflow: run?.path?.split("@")[0],
    runId: run?.id,
    runAttempt: run?.run_attempt,
    headSha: run?.head_sha,
    ref: run?.head_branch,
    event: run?.event,
    status: run?.status,
    conclusion: run?.conclusion,
  };
  for (const [key, value] of Object.entries({
    repository: REPOSITORY,
    headRepository: REPOSITORY,
    event: "workflow_dispatch",
    ...expected,
  })) {
    if (actual[key] !== value) {
      throw new Error(`ClawHub postpublish workflow ${key} mismatch.`);
    }
  }
  const successful = actual.status === "completed" && actual.conclusion === "success";
  const active =
    ["queued", "pending", "waiting", "in_progress"].includes(actual.status) &&
    actual.conclusion == null;
  const sealedTerminal =
    actual.status === "completed" && ["success", "failure"].includes(actual.conclusion);
  const recoveryTerminal =
    actual.status === "completed" &&
    ["success", "failure", "cancelled"].includes(actual.conclusion);
  const completed = actual.status === "completed" && typeof actual.conclusion === "string";
  if (
    (statePolicy === "completed-success" && !successful) ||
    (statePolicy === "sealed-producer" && !active && !sealedTerminal) ||
    (statePolicy === "recovery-producer" && !recoveryTerminal) ||
    (statePolicy === "completed-any" && !completed)
  ) {
    throw new Error("ClawHub postpublish parent state is not authorized.");
  }
}

async function githubJson(path, { token, fetchImpl }) {
  const signal = AbortSignal.timeout(60_000);
  const response = await fetchImpl(`https://api.github.com/repos/${REPOSITORY}/${path}`, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "x-github-api-version": "2026-03-10",
    },
    redirect: "error",
    signal,
  });
  if (!response.ok) {
    throw new Error(`GitHub postpublish read returned HTTP ${response.status}.`);
  }
  return JSON.parse(
    await readBoundedResponseText(response, "GitHub postpublish", 2 * 1024 * 1024, { signal }),
  );
}

async function listRunArtifacts(runId, context) {
  const artifacts = [];
  // A full plugin release produces several artifacts per package. Bound the
  // inventory without trusting an artifact's self-declared download location.
  for (let page = 1; page <= 20; page += 1) {
    const result = await githubJson(
      `actions/runs/${runId}/artifacts?per_page=100&page=${page}`,
      context,
    );
    if (
      !Array.isArray(result.artifacts) ||
      !Number.isSafeInteger(result.total_count) ||
      result.total_count > 2000
    ) {
      throw new Error("ClawHub postpublish artifact listing is invalid or exceeds its limit.");
    }
    artifacts.push(...result.artifacts);
    if (artifacts.length === result.total_count) {
      return artifacts;
    }
    if (result.artifacts.length === 0 || artifacts.length > result.total_count) {
      break;
    }
  }
  throw new Error("ClawHub postpublish artifact listing is incomplete.");
}

async function listRunJobs(run, context) {
  const key = `${run.id}/${run.run_attempt}`;
  let pending = context.runJobs.get(key);
  if (!pending) {
    pending = (async () => {
      const jobs = [];
      let total;
      for (let page = 1; page <= 20; page += 1) {
        const result = await githubJson(
          `actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100&page=${page}`,
          context,
        );
        total ??= result.total_count;
        if (
          !Number.isSafeInteger(total) ||
          total < 1 ||
          total > 2000 ||
          result.total_count !== total ||
          !Array.isArray(result.jobs) ||
          result.jobs.length === 0
        ) {
          break;
        }
        jobs.push(...result.jobs);
        if (jobs.length === total) {
          return { total_count: total, jobs };
        }
      }
      throw new Error("ClawHub dispatch producer job inventory is incomplete.");
    })();
    context.runJobs.set(key, pending);
  }
  return await pending;
}

async function downloadArtifact(artifact, run, context, maxArchiveBytes, producer) {
  const structuredProducer = producer && typeof producer === "object" ? producer : undefined;
  const producerStepName = typeof producer === "string" ? producer : structuredProducer?.stepName;
  const producerPolicy = structuredProducer
    ? (structuredProducer.runStatePolicy ?? "same-run-producer-success")
    : context.parentStatePolicy === "sealed-producer"
      ? "same-run-producer-success"
      : context.parentStatePolicy === "recovery-producer"
        ? "completed-producer-success"
        : undefined;
  const sealedProducer = producerPolicy && producerStepName;
  const boundProducer = structuredProducer || sealedProducer;
  const expected = {
    artifactId: artifact.id,
    artifactName: artifact.name,
    artifactDigest: artifact.digest,
    artifactSizeBytes: artifact.size_in_bytes,
    repository: REPOSITORY,
    runId: run.id,
    runAttempt: run.run_attempt,
    workflowSha: run.head_sha,
    workflowHeadBranch: run.head_branch,
    workflowEvent: "workflow_dispatch",
    runStatePolicy: boundProducer ? producerPolicy : "completed-success",
    workflowPath: run.path.split("@")[0],
    ...(boundProducer
      ? {
          ...(producerPolicy === "same-run-producer-success"
            ? {
                consumerRunAttempt: structuredProducer?.consumerRunAttempt ?? run.run_attempt,
              }
            : {}),
          producerJobName: structuredProducer?.jobName ?? "Publish plugins, then OpenClaw",
          ...(producerStepName ? { producerStepName } : {}),
        }
      : {}),
  };
  validateActionsArtifactBinding({
    artifactMetadata: artifact,
    workflowRun: { ...run, path: run.path.split("@")[0] },
    expected,
  });
  if (boundProducer) {
    const workflowJobs = structuredProducer?.jobs ?? (await listRunJobs(run, context));
    validateActionsArtifactProducerJob({ expected, workflowJobs });
  }
  await mkdir(context.archiveDir, { recursive: true });
  return await downloadExactActionsArtifactArchive({
    ...context,
    archivePath: join(context.archiveDir, `${artifact.id}.zip`),
    maxArchiveBytes,
    expected: {
      repository: REPOSITORY,
      artifactId: artifact.id,
      artifactName: artifact.name,
      artifactDigest: artifact.digest,
      artifactSizeBytes: artifact.size_in_bytes,
      artifactExpiresAt: artifact.expires_at,
      runId: run.id,
      workflowSha: run.head_sha,
    },
  });
}

function dispatchExecutionTimes(job, step) {
  return [job.started_at, step?.started_at, step?.completed_at, job.completed_at].map(Date.parse);
}

function dispatchProducer(jobs, run) {
  const matches = jobs.jobs.filter(
    (job) => DISPATCH_JOBS.has(job.name) && job.conclusion !== "skipped",
  );
  const job = matches[0];
  const uploads = job?.steps?.filter((step) => step.name === DISPATCH_UPLOAD_STEP);
  const step = uploads?.[0];
  if (
    matches.length !== 1 ||
    job.run_id !== run.id ||
    job.run_attempt !== run.run_attempt ||
    job.head_sha !== run.head_sha ||
    job.status !== "completed" ||
    job.conclusion !== "success" ||
    !Number.isSafeInteger(job.runner_id) ||
    job.runner_id <= 0 ||
    uploads?.length !== 1 ||
    step.status !== "completed" ||
    step.conclusion !== "success"
  ) {
    throw new Error("Missing or ambiguous successful ClawHub dispatch producer.");
  }
  const times = dispatchExecutionTimes(job, step);
  if (
    times.some((time, index) => !Number.isFinite(time) || (index > 0 && time < times[index - 1]))
  ) {
    throw new Error("ClawHub dispatch producer execution timestamps are invalid.");
  }
  return { job, step, times };
}

async function resolveDispatchRecord(parent, expectedParent, artifacts, context) {
  const prefix = `openclaw-release-children-${parent.id}-`;
  const exact = artifacts.filter((artifact) => artifact.name === `${prefix}${parent.run_attempt}`);
  if (exact.length === 1) {
    return { artifact: exact[0], run: parent };
  }
  if (exact.length > 1 || parent.run_attempt === 1) {
    throw new Error("Missing exact parent release dispatch record.");
  }
  const current = dispatchProducer(await listRunJobs(parent, context), parent);
  const retained = artifacts.filter((artifact) => {
    const attempt = artifact.name?.startsWith(prefix) ? artifact.name.slice(prefix.length) : "";
    return (
      /^[1-9][0-9]*$/u.test(attempt) &&
      Number.isSafeInteger(Number(attempt)) &&
      Number(attempt) < parent.run_attempt
    );
  });
  if (retained.length > MAX_DISPATCH_RECORDS) {
    throw new Error("ClawHub dispatch recovery exceeds its historical record limit.");
  }
  const matches = [];
  for (const artifact of retained) {
    const runAttempt = positiveId(artifact.name.slice(prefix.length), "dispatch producer attempt");
    const run = await githubJson(`actions/runs/${parent.id}/attempts/${runAttempt}`, context);
    requireRun(
      run,
      { ...expectedParent, runAttempt, conclusion: run?.conclusion },
      "completed-any",
    );
    if (run.path !== parent.path) {
      throw new Error("ClawHub dispatch producer workflow ref mismatch.");
    }
    const jobs = await listRunJobs(run, context);
    // Failed-job reruns project retained jobs under new IDs/attempts. Match the
    // authenticated execution, not the newest artifact or its creation clock.
    const sameExecution = jobs.jobs.some((job) => {
      const uploads = job.steps?.filter((step) => step.name === DISPATCH_UPLOAD_STEP);
      return (
        job.name === current.job.name &&
        job.runner_id === current.job.runner_id &&
        uploads?.length === 1 &&
        dispatchExecutionTimes(job, uploads[0]).every(
          (time, index) => time === current.times[index],
        )
      );
    });
    if (!sameExecution) {
      continue;
    }
    const original = dispatchProducer(jobs, run);
    matches.push({
      artifact,
      run,
      producer: { consumerRunAttempt: parent.run_attempt, jobName: original.job.name, jobs },
    });
  }
  if (matches.length !== 1) {
    throw new Error("Missing or ambiguous retained ClawHub dispatch record.");
  }
  return matches[0];
}

function identityFromReceipt(receipt) {
  return validateClawHubIdentity({
    version: 2,
    repository: REPOSITORY,
    workflow: CHILD_WORKFLOW,
    runId: String(positiveId(receipt.childRunId, "child run")),
    runAttempt: String(positiveId(receipt.childRunAttempt, "child attempt")),
    ref: receipt.childRef,
    fullRef: receipt.childFullRef,
    sha: receipt.childHeadSha,
    candidateRepository: REPOSITORY,
    candidateSha: receipt.candidateSha,
    toolingRef: receipt.toolingRef,
    toolingFullRef: receipt.toolingFullRef,
    toolingSha: receipt.toolingSha,
    parentRepository: REPOSITORY,
    parentWorkflow: PARENT_WORKFLOW,
    parentRunId: receipt.runId,
    parentRunAttempt: receipt.runAttempt,
  });
}

export async function verifyClawHubPostpublish({
  event,
  parent: suppliedParent = event?.workflow_run,
  parentStatePolicy = "completed-success",
  verifierSha,
  token,
  outputDir,
  fetchImpl = fetch,
  runGh,
  verifyPublication = true,
  recoveryManifest = event?.recovery_manifest,
}) {
  const trigger = suppliedParent;
  const runId = positiveId(trigger?.id, "parent run");
  const runAttempt = positiveId(trigger?.run_attempt, "parent attempt");
  const expectedParent = {
    workflow: PARENT_WORKFLOW,
    runId,
    runAttempt,
    headSha: trigger?.head_sha,
    ref: trigger?.head_branch,
  };
  requireRun(trigger, expectedParent, parentStatePolicy);
  const context = {
    token,
    fetchImpl,
    archiveDir: join(outputDir, "archives"),
    parentStatePolicy,
    runJobs: new Map(),
  };
  const parent = await githubJson(`actions/runs/${runId}/attempts/${runAttempt}`, context);
  requireRun(parent, expectedParent, parentStatePolicy);
  const artifacts = await listRunArtifacts(runId, context);
  const dispatchRecord = await resolveDispatchRecord(parent, expectedParent, artifacts, context);
  const dispatchRunAttempt = dispatchRecord.run.run_attempt;
  const { archiveBytes: dispatchZip } = await downloadArtifact(
    dispatchRecord.artifact,
    dispatchRecord.run,
    context,
    MAX_RECEIPT_BYTES + 4096,
    dispatchRecord.producer ?? "Upload exact release child dispatch record",
  );
  const dispatchFiles = inspectActionsArtifactZip(dispatchZip, ["dispatch.json"], {
    maxEntryBytes: MAX_RECEIPT_BYTES,
    maxExpandedBytes: MAX_RECEIPT_BYTES,
  });
  const dispatch = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(dispatchFiles.get("dispatch.json")),
  );
  const dispatchFields = [
    "schemaVersion",
    "repository",
    "parentRunId",
    "parentRunAttempt",
    "parentWorkflow",
    "toolingRef",
    "toolingFullRef",
    "toolingSha",
    "candidateSha",
    "normalClawHubRunId",
    "normalClawHubRunAttempt",
  ];
  if (
    !dispatch ||
    Object.keys(dispatch).length !== dispatchFields.length ||
    dispatchFields.some((key) => !Object.hasOwn(dispatch, key)) ||
    dispatch.schemaVersion !== 1 ||
    dispatch.repository !== REPOSITORY ||
    String(dispatch.parentRunId) !== String(runId) ||
    String(dispatch.parentRunAttempt) !== String(dispatchRunAttempt) ||
    dispatch.parentWorkflow !== PARENT_WORKFLOW ||
    dispatch.toolingRef !== parent.head_branch ||
    dispatch.toolingSha !== parent.head_sha ||
    !/^[a-f0-9]{40}$/u.test(dispatch.candidateSha)
  ) {
    throw new Error("Parent dispatch record identity mismatch.");
  }
  verifyReleaseToolingIdentity({
    repository: REPOSITORY,
    workflowRef: dispatch.toolingRef,
    workflowFullRef: dispatch.toolingFullRef,
    workflowSha: parent.head_sha,
    runGh,
  });
  if (!/^[a-f0-9]{40}$/u.test(verifierSha)) {
    throw new Error("Invalid trusted verifier SHA.");
  }
  // GitHub includes file patches only on page 1; status describes the full comparison.
  const ancestry = await githubJson(
    `compare/${parent.head_sha}...${verifierSha}?per_page=1&page=2`,
    context,
  );
  if (ancestry.status !== "ahead" && ancestry.status !== "identical") {
    throw new Error("Parent tooling is not an ancestor of trusted verification tooling.");
  }
  const parentQualifiedRef = parent.path.split("@")[1];
  if (parentQualifiedRef !== undefined && parentQualifiedRef !== dispatch.toolingFullRef) {
    throw new Error("Parent workflow full ref mismatch.");
  }
  await mkdir(outputDir, { recursive: true });
  if (dispatch.normalClawHubRunId === null && dispatch.normalClawHubRunAttempt === null) {
    const evidence = {
      schemaVersion: 1,
      repository: REPOSITORY,
      parentRunId: runId,
      parentRunAttempt: runAttempt,
      dispatchRunAttempt,
      complete: true,
      outcome: "no-normal-clawhub-publication",
      dispatchArtifactId: dispatchRecord.artifact.id,
      dispatchArtifactDigest: dispatchRecord.artifact.digest,
      packages: [],
    };
    await writeFile(join(outputDir, "evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`);
    return evidence;
  }
  positiveId(dispatch.normalClawHubRunId, "dispatched child run");
  positiveId(dispatch.normalClawHubRunAttempt, "dispatched child attempt");
  const prefix = `openclaw-clawhub-parent-authorization-v2-${runId}-${dispatchRunAttempt}-`;
  const receipts = artifacts.filter((artifact) => artifact.name?.startsWith(prefix));
  if (receipts.length !== 1) {
    throw new Error("Expected exactly one ClawHub parent authorization artifact for this attempt.");
  }
  const receiptArtifact = receipts[0];
  const { archiveBytes } = await downloadArtifact(
    receiptArtifact,
    dispatchRecord.run,
    context,
    MAX_RECEIPT_BYTES + 4096,
    dispatchRecord.producer ?? "Upload immutable ClawHub parent authorization",
  );
  const files = inspectActionsArtifactZip(archiveBytes, ["authorization.json"], {
    maxEntryBytes: MAX_RECEIPT_BYTES,
    maxExpandedBytes: MAX_RECEIPT_BYTES,
  });
  const receipt = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(files.get("authorization.json")),
  );
  if (
    ["sealed-producer", "recovery-producer"].includes(parentStatePolicy) &&
    receipt.authorizationRoute !== "automated-sealed"
  ) {
    throw new Error("ClawHub sealed verification requires the automated-sealed route.");
  }
  const identity = identityFromReceipt(receipt);
  if (
    identity.runId !== String(dispatch.normalClawHubRunId) ||
    identity.runAttempt !== String(dispatch.normalClawHubRunAttempt) ||
    identity.candidateSha !== dispatch.candidateSha ||
    identity.toolingFullRef !== dispatch.toolingFullRef
  ) {
    throw new Error("Parent receipt does not bind its dispatched child.");
  }
  if (
    receiptArtifact.name !== `${prefix}${identity.runId}-${identity.runAttempt}` ||
    receipt.runId !== String(runId) ||
    receipt.runAttempt !== String(dispatchRunAttempt) ||
    receipt.headSha !== parent.head_sha ||
    receipt.ref !== parent.head_branch
  ) {
    throw new Error("ClawHub parent receipt does not bind the triggering run attempt.");
  }
  let child;
  const completedProducer = parentStatePolicy !== "completed-success";
  const childDeadline = Date.now() + 30 * 60 * 1000;
  for (;;) {
    child = await githubJson(
      `actions/runs/${identity.runId}/attempts/${identity.runAttempt}`,
      context,
    );
    validateClawHubWorkflowRun(child, identity, { completedProducer });
    if (child.status === "completed") {
      break;
    }
    if (Date.now() >= childDeadline) {
      throw new Error("ClawHub child did not complete within the postpublish deadline.");
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 10_000);
    });
  }
  validateClawHubWorkflowRun(child, identity, {
    terminal: !completedProducer,
    completedProducer,
  });
  const childQualifiedRef = child.path.split("@")[1];
  if (childQualifiedRef !== undefined && childQualifiedRef !== identity.fullRef) {
    throw new Error("Child workflow full ref mismatch.");
  }
  const downloaded = await downloadClawHubTransactions({
    identity,
    ...context,
    archivePath: join(
      context.archiveDir,
      `transactions-${identity.runId}-${identity.runAttempt}.zip`,
    ),
    runGhJson: runGh
      ? (path) => JSON.parse(runGh(["api", `repos/${REPOSITORY}/${path}`, "--method", "GET"]))
      : undefined,
    completedProducer,
  });
  const transactions = downloaded.transactions;
  validateClawHubParentAuthorization(receipt, transactions);
  const childArtifacts = await listRunArtifacts(child.id, context);
  let originalManifest = recoveryManifest;
  if (!originalManifest) {
    const manifestName = `openclaw-clawhub-recovery-manifest-${child.id}-${child.run_attempt}`;
    const manifests = childArtifacts.filter((artifact) => artifact.name === manifestName);
    if (
      manifests.length > 1 ||
      (manifests.length === 0 && (completedProducer || !verifyPublication))
    ) {
      throw new Error("Missing or ambiguous sealed ClawHub original attempt roster.");
    }
    if (manifests.length === 1) {
      const { archiveBytes: manifestArchiveBytes } = await downloadArtifact(
        manifests[0],
        child,
        context,
        MAX_RECEIPT_BYTES + 4096,
        {
          jobName: "Seal exact ClawHub recovery manifest",
          stepName: "Upload sealed recovery manifest",
          runStatePolicy: "completed-producer-success",
        },
      );
      const manifestFiles = inspectActionsArtifactZip(
        manifestArchiveBytes,
        ["recovery-manifest.json"],
        {
          maxEntryBytes: MAX_RECEIPT_BYTES,
          maxExpandedBytes: MAX_RECEIPT_BYTES,
        },
      );
      originalManifest = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(
          manifestFiles.get("recovery-manifest.json"),
        ),
      );
    }
  }
  const validatedRecoveryManifest = originalManifest
    ? validateClawHubRecoveryManifest(originalManifest)
    : undefined;
  if (validatedRecoveryManifest) {
    const recoveryTransactions = validatedRecoveryManifest.packages.map(
      ({ name, version, inventoryDigest, artifactName, artifactSha256, artifactSize }) => ({
        name,
        version,
        inventoryDigest,
        artifactName,
        artifactSha256,
        artifactSize,
      }),
    );
    if (
      JSON.stringify(validatedRecoveryManifest.identity) !== JSON.stringify(identity) ||
      JSON.stringify(recoveryTransactions) !== JSON.stringify(transactions.packages)
    ) {
      throw new Error("ClawHub recovery manifest changed the authorized transaction roster.");
    }
  }
  const evidence = {
    schemaVersion: 1,
    repository: REPOSITORY,
    parentRunId: runId,
    parentRunAttempt: runAttempt,
    dispatchRunAttempt,
    childRunId: child.id,
    childRunAttempt: child.run_attempt,
    toolingSha: parent.head_sha,
    candidateSha: identity.candidateSha,
    dispatchArtifactId: dispatchRecord.artifact.id,
    dispatchArtifactDigest: dispatchRecord.artifact.digest,
    receiptArtifactId: receiptArtifact.id,
    receiptArtifactDigest: receiptArtifact.digest,
    packages: [],
    publicationAttempts: (validatedRecoveryManifest?.packages ?? []).map(
      ({ name, version, attemptId, publicationStatus }) => ({
        name,
        version,
        attemptId,
        publicationStatus,
      }),
    ),
    complete: false,
  };
  await mkdir(outputDir, { recursive: true });
  const save = () =>
    writeFile(join(outputDir, "evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`);
  await save();
  if (!verifyPublication && validatedRecoveryManifest) {
    evidence.outcome = "authorized-recovery-roster";
    evidence.packages = validatedRecoveryManifest.packages;
    evidence.complete = true;
    await save();
    return evidence;
  }
  // One scan worker turn (25 minutes) plus its five-minute scheduled admission.
  const publicationDeadline = Date.now() + 30 * 60 * 1000;
  // Registry reads carry no GitHub credentials. Each package is checked against
  // the exact bytes and inventory authorized by the sealed parent.
  for (let index = 0; index < transactions.packages.length; index += 8) {
    const results = await Promise.allSettled(
      transactions.packages.slice(index, index + 8).map(async (entry) => {
        const matches = childArtifacts.filter((artifact) => artifact.name === entry.artifactName);
        if (matches.length !== 1) {
          throw new Error(`Expected one package artifact for ${entry.name}.`);
        }
        const { archiveBytes: packageZip } = await downloadArtifact(
          matches[0],
          child,
          context,
          130 * 1024 * 1024,
          completedProducer
            ? {
                stepName: "Upload ClawHub package artifact",
                jobName: `Pack ClawHub package (${entry.name})`,
                runStatePolicy: "completed-producer-success",
              }
            : undefined,
        );
        const packageFiles = inspectActionsArtifactZip(packageZip, 1, {
          maxEntryBytes: 120 * 1024 * 1024,
        });
        const [[fileName, bytes]] = packageFiles;
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.tgz$/u.test(fileName)) {
          throw new Error("ClawHub package artifact must contain one root tarball.");
        }
        const artifactDir = join(outputDir, String(matches[0].id));
        await mkdir(artifactDir, { recursive: true });
        const tarballPath = join(artifactDir, fileName);
        try {
          await writeFile(tarballPath, bytes, { flag: "wx", mode: 0o600 });
        } catch (error) {
          if (error?.code !== "EEXIST") {
            throw error;
          }
          // Retained output is reusable content, never publication authority.
          // Refuse modified or symlinked files instead of overwriting evidence.
          const retained = readBoundedRegularFile(tarballPath, {
            label: "Retained ClawHub package",
            maxBytes: 120 * 1024 * 1024,
          });
          if (!retained.equals(bytes)) {
            throw new Error(`Retained ClawHub package bytes mismatch: ${entry.name}.`, {
              cause: error,
            });
          }
        }
        const packed = readPackedClawHubTransaction({
          artifactDir,
          packageName: entry.name,
          version: entry.version,
          artifactName: entry.artifactName,
        });
        if (Object.keys(packed).some((key) => packed[key] !== entry[key])) {
          throw new Error(`ClawHub package transaction changed: ${entry.name}.`);
        }
        const publishTag = entry.version.includes("-alpha.")
          ? "alpha"
          : entry.version.includes("-beta.")
            ? "beta"
            : "latest";
        const original = validatedRecoveryManifest?.packages.find(
          (item) => item.name === entry.name,
        );
        const observed = evidence.publicationAttempts.find((item) => item.name === entry.name);
        // Historical successful publishers have no attempt roster. Their authenticated
        // transaction bytes still verify, but cannot authorize waiting on an unknown attempt.
        if (original) {
          await waitForClawHubPublicVersion(original, {
            deadline: publicationDeadline,
            fetchImpl,
            onState: (publication) => {
              observed.publication = publication;
            },
          });
        }
        const verified = await verifyPublishedClawHubPackage({
          expectedArtifactDir: artifactDir,
          packageName: entry.name,
          packageVersion: entry.version,
          publishTag,
          retryOptions: { fetchImpl },
        });
        return Object.assign(verified, {
          artifactId: matches[0].id,
          artifactDigest: matches[0].digest,
          inventoryDigest: entry.inventoryDigest,
        });
      }),
    );
    for (const result of results) {
      if (result.status === "fulfilled") {
        evidence.packages.push(result.value);
      }
    }
    await save();
    const failure = results.find((result) => result.status === "rejected");
    if (failure) {
      throw failure.reason;
    }
  }
  evidence.complete = true;
  await save();
  return evidence;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    const parent = process.env.PARENT_RUN_ID
      ? {
          id: Number(process.env.PARENT_RUN_ID),
          run_attempt: Number(process.env.PARENT_RUN_ATTEMPT),
          path: PARENT_WORKFLOW,
          head_branch: process.env.PARENT_REF,
          head_sha: process.env.PARENT_SHA,
          event: "workflow_dispatch",
          status: process.env.PARENT_STATUS,
          conclusion: process.env.PARENT_CONCLUSION || null,
          repository: { full_name: REPOSITORY },
          head_repository: { full_name: REPOSITORY },
        }
      : undefined;
    await verifyClawHubPostpublish({
      event: JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, "utf8")),
      parent,
      parentStatePolicy:
        process.env.PARENT_STATE_POLICY ?? (parent ? "sealed-producer" : "completed-success"),
      verifierSha: process.env.VERIFIER_SHA,
      token: process.env.GH_TOKEN,
      outputDir: join(process.env.RUNNER_TEMP, "clawhub-postpublish"),
      verifyPublication: process.env.VERIFY_PUBLICATION !== "false",
      recoveryManifest: process.env.RECOVERY_MANIFEST
        ? JSON.parse(await readFile(process.env.RECOVERY_MANIFEST, "utf8"))
        : undefined,
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error("[clawhub-postpublish] FAILED (exit 1)");
    process.exitCode = 1;
  }
}
