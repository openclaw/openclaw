#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
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
import {
  executeClawHubRecoveryManifest,
  validateClawHubRecoveryManifest,
} from "./plugin-clawhub-recovery.mjs";
import { downloadReleaseApprovalReceipt } from "./release-approval-receipt.mjs";
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

// `recover.revalidateAuthority(selectedManifest)` must freshly validate the
// current parent admission against the original identity and selected versions.
// It is awaited immediately before each recovery POST and before completion;
// neither this callback nor the selected view replaces the original sealed roster.
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
  plugins = undefined,
  recover = undefined,
}) {
  if (recover && (!verifyPublication || typeof recover.revalidateAuthority !== "function")) {
    throw new Error("ClawHub recovery requires public readback and current parent authority.");
  }
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
  if (Object.hasOwn(dispatch ?? {}, "clawHubDeferred")) {
    dispatchFields.push("clawHubDeferred");
  }
  if (
    !dispatch ||
    (Object.hasOwn(dispatch, "clawHubDeferred") &&
      (dispatch.clawHubDeferred !== true ||
        dispatch.normalClawHubRunId !== null ||
        dispatch.normalClawHubRunAttempt !== null)) ||
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
    if (plugins !== undefined || recover) {
      throw new Error("ClawHub recovery selection requires an original sealed child.");
    }
    const evidence = {
      schemaVersion: 1,
      repository: REPOSITORY,
      parentRunId: runId,
      parentRunAttempt: runAttempt,
      dispatchRunAttempt,
      complete: dispatch.clawHubDeferred !== true,
      outcome: dispatch.clawHubDeferred ? "clawhub-deferred" : "no-normal-clawhub-publication",
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
  let originalManifest;
  {
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
  // A local manifest is only a copy to compare, never authority to bypass the
  // original artifact or its successful seal-producing job. Authenticate the
  // full roster before deriving an operation; retain the original identity.
  if (recoveryManifest && !isDeepStrictEqual(recoveryManifest, validatedRecoveryManifest)) {
    throw new Error("Supplied ClawHub recovery manifest differs from the authenticated seal.");
  }
  let selectedPackages = transactions.packages;
  if (plugins !== undefined) {
    const names = typeof plugins === "string" ? plugins.split(/[,\s]+/u).filter(Boolean) : [];
    if (
      !validatedRecoveryManifest ||
      names.length === 0 ||
      new Set(names).size !== names.length ||
      names.some((name) => !transactions.packages.some((entry) => entry.name === name))
    ) {
      throw new Error("ClawHub recovery selection must be a nonempty subset of the sealed roster.");
    }
    selectedPackages = transactions.packages.filter((entry) => names.includes(entry.name));
  }
  const selectedManifest = validatedRecoveryManifest && {
    ...validatedRecoveryManifest,
    packages: validatedRecoveryManifest.packages.filter((entry) =>
      selectedPackages.some((selected) => selected.name === entry.name),
    ),
  };
  if (recover && !selectedManifest) {
    throw new Error("ClawHub recovery requires the authenticated original attempt roster.");
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
    evidence.packages = selectedManifest.packages;
    evidence.complete = selectedPackages.length === transactions.packages.length;
    await save();
    return evidence;
  }
  if (recover) {
    // The caller owns the current parent admission; the original seal only
    // identifies immutable transactions. Recheck that admission at each effect.
    await executeClawHubRecoveryManifest({
      ...recover,
      manifest: selectedManifest,
      revalidateAuthority: () => recover.revalidateAuthority(selectedManifest),
    });
  }
  // One scan worker turn (25 minutes) plus its five-minute scheduled admission.
  const publicationDeadline = Date.now() + 30 * 60 * 1000;
  // Registry reads carry no GitHub credentials. Each package is checked against
  // the exact bytes and inventory authorized by the sealed parent.
  for (let index = 0; index < selectedPackages.length; index += 8) {
    const results = await Promise.allSettled(
      selectedPackages.slice(index, index + 8).map(async (entry) => {
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
  await recover?.revalidateAuthority(selectedManifest);
  // A completed batch is not evidence that excluded siblings are public.
  evidence.complete = selectedPackages.length === transactions.packages.length;
  await save();
  return evidence;
}

// The request is the ordinary workflow_dispatch transport, authenticated by its
// exact parent artifact, not a second admission or a replacement roster.
export async function recoverClawHubFromParent({
  event,
  env = process.env,
  fetchImpl = fetch,
  runGh,
  evidenceClient = undefined,
}) {
  const inputs = event?.inputs;
  const fields = [
    "original_child_run_id",
    "original_child_run_attempt",
    "reason",
    "plugins",
    "release_publish_run_id",
    "release_publish_run_attempt",
    "full_release_validation_run_id",
    "full_release_validation_run_attempt",
  ];
  if (!inputs || fields.some((key) => typeof inputs[key] !== "string")) {
    throw new Error("Parent ClawHub recovery requires every internal dispatch input.");
  }
  for (const key of fields.filter((field) => field.endsWith("_id") || field.endsWith("_attempt"))) {
    positiveId(inputs[key], key);
  }
  if (
    !inputs.reason.trim() ||
    inputs.reason.trim().length > 500 ||
    env.GITHUB_REPOSITORY !== REPOSITORY ||
    env.GITHUB_EVENT_NAME !== "workflow_dispatch" ||
    env.GITHUB_WORKFLOW_REF !==
      `${REPOSITORY}/.github/workflows/plugin-clawhub-recovery.yml@${env.GITHUB_REF}`
  ) {
    throw new Error("Invalid parent ClawHub recovery execution.");
  }
  const outputDir = join(env.RUNNER_TEMP, "clawhub-postpublish");
  const context = {
    token: env.GH_TOKEN,
    fetchImpl,
    archiveDir: join(outputDir, "archives"),
    runJobs: new Map(),
  };
  const current = await githubJson(`actions/runs/${inputs.release_publish_run_id}`, context);
  requireRun(
    current,
    {
      workflow: PARENT_WORKFLOW,
      runId: positiveId(inputs.release_publish_run_id, "current parent run"),
      runAttempt: positiveId(inputs.release_publish_run_attempt, "current parent attempt"),
      headSha: env.GITHUB_WORKFLOW_SHA,
      ref: env.GITHUB_REF_NAME,
    },
    "sealed-producer",
  );
  if (
    current.status !== "in_progress" ||
    current.conclusion !== null ||
    current.path !== `${PARENT_WORKFLOW}@${env.GITHUB_REF}`
  ) {
    throw new Error("ClawHub recovery requires the executing tooling's active parent.");
  }
  const approvalExpected = {
    repository: REPOSITORY,
    parentRunId: inputs.release_publish_run_id,
    parentRunAttempt: inputs.release_publish_run_attempt,
    toolingRef: current.head_branch,
    toolingFullRef: current.path.split("@")[1],
    toolingSha: current.head_sha,
    parentStatePolicy: "active",
  };
  const approval = (expected = {}) =>
    downloadReleaseApprovalReceipt({
      expected: { ...approvalExpected, ...expected },
      token: env.GH_TOKEN,
      fetchImpl,
      ...(runGh
        ? {
            runGhJson: (path) =>
              JSON.parse(runGh(["api", `repos/${REPOSITORY}/${path}`, "--method", "GET"])),
          }
        : {}),
    });
  const { receipt: currentApproval } = await approval();
  const name = `openclaw-clawhub-recovery-request-${current.id}-${current.run_attempt}`;
  const artifacts = (await listRunArtifacts(current.id, context)).filter(
    (item) => item.name === name,
  );
  if (artifacts.length !== 1) {
    throw new Error("Missing or ambiguous exact ClawHub recovery request.");
  }
  const [artifact] = artifacts;
  validateActionsArtifactBinding({
    artifactMetadata: artifact,
    workflowRun: { ...current, path: PARENT_WORKFLOW },
    expected: {
      artifactId: artifact.id,
      artifactName: name,
      artifactDigest: artifact.digest,
      artifactSizeBytes: artifact.size_in_bytes,
      repository: REPOSITORY,
      runId: current.id,
      runAttempt: current.run_attempt,
      workflowSha: current.head_sha,
      workflowHeadBranch: current.head_branch,
      workflowEvent: "workflow_dispatch",
      workflowPath: PARENT_WORKFLOW,
      runStatePolicy: "same-run-producer-success",
      consumerRunAttempt: current.run_attempt,
      producerJobName: "Publish plugins, then OpenClaw",
      producerStepName: "Upload ClawHub recovery request",
    },
  });
  // The parent job is waiting for this child. Authenticate its completed upload
  // step without requiring the waiting job itself to have finished.
  const jobs = (await listRunJobs(current, context)).jobs.filter(
    (job) => job.name === "Publish plugins, then OpenClaw",
  );
  const job = jobs[0];
  const steps = job?.steps?.filter((step) => step.name === "Upload ClawHub recovery request");
  if (
    jobs.length !== 1 ||
    job.run_id !== current.id ||
    job.run_attempt !== current.run_attempt ||
    job.head_sha !== current.head_sha ||
    job.status !== "in_progress" ||
    job.conclusion !== null ||
    steps?.length !== 1 ||
    steps[0].status !== "completed" ||
    steps[0].conclusion !== "success"
  ) {
    throw new Error("ClawHub recovery request upload is not from the active approved parent job.");
  }
  const { archiveBytes } = await downloadExactActionsArtifactArchive({
    token: env.GH_TOKEN,
    fetchImpl,
    maxArchiveBytes: MAX_RECEIPT_BYTES + 4096,
    expected: {
      repository: REPOSITORY,
      artifactId: artifact.id,
      artifactName: name,
      artifactDigest: artifact.digest,
      artifactSizeBytes: artifact.size_in_bytes,
      artifactExpiresAt: artifact.expires_at,
      runId: current.id,
      workflowSha: current.head_sha,
    },
  });
  const files = inspectActionsArtifactZip(archiveBytes, ["dispatch.json"], {
    maxEntryBytes: MAX_RECEIPT_BYTES,
    maxExpandedBytes: MAX_RECEIPT_BYTES,
  });
  const request = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(files.get("dispatch.json")),
  );
  if (!isDeepStrictEqual(request, { ref: env.GITHUB_REF_NAME, inputs })) {
    throw new Error("ClawHub recovery dispatch differs from the authenticated parent request.");
  }
  const child = await githubJson(
    `actions/runs/${inputs.original_child_run_id}/attempts/${inputs.original_child_run_attempt}`,
    context,
  );
  requireRun(
    child,
    {
      workflow: CHILD_WORKFLOW,
      runId: Number(inputs.original_child_run_id),
      runAttempt: Number(inputs.original_child_run_attempt),
      headSha: child.head_sha,
      ref: child.head_branch,
    },
    "recovery-producer",
  );
  const sealName = `openclaw-clawhub-recovery-manifest-${child.id}-${child.run_attempt}`;
  const seals = (await listRunArtifacts(child.id, context)).filter(
    (item) => item.name === sealName,
  );
  if (seals.length !== 1) {
    throw new Error("Missing or ambiguous original ClawHub seal.");
  }
  const { archiveBytes: sealArchive } = await downloadArtifact(
    seals[0],
    child,
    context,
    MAX_RECEIPT_BYTES + 4096,
    {
      jobName: "Seal exact ClawHub recovery manifest",
      stepName: "Upload sealed recovery manifest",
      runStatePolicy: "completed-producer-success",
    },
  );
  const sealFiles = inspectActionsArtifactZip(sealArchive, ["recovery-manifest.json"], {
    maxEntryBytes: MAX_RECEIPT_BYTES,
    maxExpandedBytes: MAX_RECEIPT_BYTES,
  });
  const seal = validateClawHubRecoveryManifest(
    JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(sealFiles.get("recovery-manifest.json")),
    ),
  );
  validateClawHubWorkflowRun(child, seal.identity, { completedProducer: true });
  // The original publication parent is not the FRV qualification parent.
  const originalParent = await githubJson(
    `actions/runs/${seal.identity.parentRunId}/attempts/${seal.identity.parentRunAttempt}`,
    context,
  );
  let authenticated;
  let expectedRelease;
  const revalidateAuthority = async (selectedManifest) => {
    if (!authenticated) {
      const { createReleaseEvidenceClient } = await import("./release-ci-summary.mjs");
      const { authenticateFullReleaseValidationEvidence } =
        await import("./validate-full-release-validation-evidence.mjs");
      const client = evidenceClient ?? createReleaseEvidenceClient(REPOSITORY);
      const runId = inputs.full_release_validation_run_id;
      const runAttempt = Number(inputs.full_release_validation_run_attempt);
      const { manifest } = await client.loadManifest(runId, runAttempt);
      authenticated = await authenticateFullReleaseValidationEvidence(
        {
          run: await client.getRunAttempt(runId, runAttempt),
          manifest,
          expectedRepository: REPOSITORY,
          expectedRunId: runId,
          expectedRunAttempt: runAttempt,
          expectedTargetSha: selectedManifest.identity.candidateSha,
          expectedReleaseTag: currentApproval.releaseTag,
          expectedTrustedWorkflowFullRef: approvalExpected.toolingFullRef,
          expectedTrustedWorkflowSha: current.head_sha,
          verifierSourceSha: current.head_sha,
          verifierSourceContent: await readFile(
            new URL("./release-ci-summary.mjs", import.meta.url),
          ),
          isTrustedMainAncestor: (sha) => {
            const comparison = client.compareCommits(sha, "main");
            return (
              ["ahead", "identical"].includes(comparison.status) &&
              comparison.merge_base_commit?.sha === sha
            );
          },
          expectedPublicationOperation: () => {
            const source = manifest.sourceAdmission;
            const selection = source?.publicationSelection;
            const admittedPackages = source?.projection?.packages.filter((entry) =>
              entry.targets.includes("clawhub"),
            );
            if (
              !selection ||
              (!inputs.plugins && selectedManifest.packages.length !== admittedPackages.length) ||
              selectedManifest.packages.some(
                (entry) =>
                  !admittedPackages.some(
                    (admitted) =>
                      admitted.name === entry.name && admitted.version === entry.version,
                  ),
              )
            ) {
              throw new Error(
                "ClawHub recovery is outside the original admitted name/version roster.",
              );
            }
            expectedRelease = {
              targetSha: selectedManifest.identity.candidateSha,
              releaseTag: currentApproval.releaseTag,
              npmDistTag: selection.npmDistTag,
            };
            return inputs.plugins
              ? {
                  ...selection,
                  pluginPublishScope: "selected",
                  publishOpenclawNpm: false,
                  plugins: selectedManifest.packages.map((entry) => entry.name).toSorted(),
                }
              : selection;
          },
        },
        client,
      );
    }
    await authenticated.revalidateAuthority?.();
    await approval(expectedRelease);
  };
  return await verifyClawHubPostpublish({
    event,
    parent: originalParent,
    parentStatePolicy: "recovery-producer",
    verifierSha: current.head_sha,
    token: env.GH_TOKEN,
    outputDir,
    fetchImpl,
    runGh,
    recoveryManifest: seal,
    plugins: inputs.plugins || undefined,
    recover: { token: env.CLAWHUB_TOKEN, reason: inputs.reason, fetchImpl, revalidateAuthority },
  });
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
    const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, "utf8"));
    if (process.argv[2] === "recover-from-parent") {
      await recoverClawHubFromParent({ event });
    } else {
      await verifyClawHubPostpublish({
        event,
        parent,
        parentStatePolicy:
          process.env.PARENT_STATE_POLICY ?? (parent ? "sealed-producer" : "completed-success"),
        verifierSha: process.env.VERIFIER_SHA,
        token: process.env.GH_TOKEN,
        outputDir: join(process.env.RUNNER_TEMP, "clawhub-postpublish"),
        verifyPublication: process.env.VERIFY_PUBLICATION !== "false",
        plugins: process.env.PLUGINS || undefined,
        recoveryManifest: process.env.RECOVERY_MANIFEST
          ? JSON.parse(await readFile(process.env.RECOVERY_MANIFEST, "utf8"))
          : undefined,
      });
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error("[clawhub-postpublish] FAILED (exit 1)");
    process.exitCode = 1;
  }
}
