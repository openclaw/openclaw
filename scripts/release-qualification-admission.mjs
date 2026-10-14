#!/usr/bin/env node
// P authenticates the operator request; Q supplies immutable policy data, never code.
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import {
  inspectActionsArtifactZipWithPolicy,
  readBoundedRegularFile,
  validateActionsArtifactBinding,
  validateActionsArtifactProducerJob,
} from "./lib/actions-artifact-archive.mjs";
import { canonicalizeJsonValue, compareAscii } from "./lib/canonical-json.mjs";
import { releaseChildDispatchInputs } from "./lib/full-release-child-request.mjs";
import { execPlainGh } from "./lib/plain-gh.mjs";
import {
  QUALIFICATION_BASELINE_POLICY_PATH,
  qualificationBaselinePolicy,
  validateQualificationBaselinePolicy,
} from "./lib/qualification-admission-baselines.mjs";
import { isRecord } from "./lib/record-shared.mjs";
import {
  QUALIFICATION_COVERAGE_PATH,
  resolveQualificationCoverage,
  validateQualificationCoverage,
  qualificationCoverageSha256,
} from "./release-qualification-coverage.mjs";
import { verifyReleaseToolingIdentity } from "./release-tooling-identity.mjs";

export const QUALIFICATION_ADMISSION_WORKFLOW = ".github/workflows/openclaw-release-prepare.yml";
export const QUALIFICATION_WORKFLOW = ".github/workflows/full-release-validation.yml";
export const QUALIFICATION_ADMISSION_FILE = "qualification-admission.json";
export const QUALIFICATION_ADMISSION_JOB = "Admit frozen candidate qualification";
export const QUALIFICATION_ADMISSION_UPLOAD = "Upload immutable qualification admission";
const REPOSITORY = "openclaw/openclaw";
const REQUEST_KIND = "openclaw.release-qualification-request/v1";
const RECEIPT_KIND = "openclaw.release-qualification-admission/v1";
const MAX_BYTES = 256 * 1024;
const MAX_ARCHIVE_BYTES = 512 * 1024;
const SHA = /^[a-f0-9]{40}$/u;
const DIGEST = /^sha256:[a-f0-9]{64}$/u;

function requireValue(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function exactKeys(value, keys, label) {
  requireValue(
    isRecord(value) &&
      isDeepStrictEqual(Object.keys(value).toSorted(compareAscii), keys.toSorted(compareAscii)),
    "Invalid " + label + " fields",
  );
}

function canonical(value) {
  const text = JSON.stringify(canonicalizeJsonValue(value));
  requireValue(
    Buffer.byteLength(text) <= MAX_BYTES,
    "Qualification admission exceeds its byte limit",
  );
  return text;
}

function digest(value) {
  return "sha256:" + createHash("sha256").update(value).digest("hex");
}

function json(raw, label) {
  requireValue(typeof raw === "string" || Buffer.isBuffer(raw), "Invalid " + label + " response");
  requireValue(Buffer.byteLength(raw) <= MAX_BYTES * 4, "Oversized " + label + " response");
  return JSON.parse(String(raw));
}

// Same synchronous args adapter as release-tooling-identity; ZIP calls preserve bytes.
export function runQualificationAdmissionGh(inputArgs) {
  const args = [...inputArgs];
  if (args[0] === "api") {
    if (!args.includes("--hostname")) {
      args.push("--hostname", "github.com");
    }
    if (!args.includes("Cache-Control: max-age=0")) {
      args.push("-H", "Cache-Control: max-age=0");
    }
  }
  const binary = args.some((arg) => /\/actions\/artifacts\/[1-9][0-9]*\/zip$/u.test(arg));
  const options = {
    encoding: binary ? null : "utf8",
    timeout: 60_000,
    killSignal: "SIGKILL",
    maxBuffer: binary ? MAX_ARCHIVE_BYTES : MAX_BYTES * 4,
    stdio: ["ignore", "pipe", "pipe"],
  };
  if (!binary) {
    return execPlainGh(args, options);
  }
  try {
    return execPlainGh([...args, "--allow-escape-sequences"], options);
  } catch (error) {
    // Older GitHub CLIs predate terminal-output sanitization and this option.
    if (
      !String(error?.stderr)
        .split(/\r?\n/u)
        .some((line) => line.trim() === "unknown flag: --allow-escape-sequences")
    ) {
      throw error;
    }
    return execPlainGh(args, options);
  }
}

function apiArgs(repository, path) {
  return [
    "api",
    "repos/" + repository + "/" + path,
    "--method",
    "GET",
    "--hostname",
    "github.com",
    "-H",
    "Cache-Control: max-age=0",
    "-H",
    "X-GitHub-Api-Version: 2026-03-10",
  ];
}

function api(repository, path, runGh) {
  return json(runGh(apiArgs(repository, path)), path);
}

export function semanticQualificationInputs(inputs) {
  requireValue(
    isRecord(inputs) && Object.keys(inputs).length <= 25,
    "Invalid qualification inputs",
  );
  const wire = {};
  for (const [key, value] of Object.entries(inputs)) {
    requireValue(
      /^[a-z][a-z0-9_]*$/u.test(key) &&
        (typeof value === "string" ||
          typeof value === "boolean" ||
          (typeof value === "number" && Number.isFinite(value))),
      "Invalid qualification input value",
    );
    wire[key] = String(value);
  }
  requireValue(
    typeof wire.trusted_workflow_json === "string",
    "Qualification source envelope is required",
  );
  const envelope = json(wire.trusted_workflow_json, "qualification source envelope");
  requireValue(isRecord(envelope), "Qualification source envelope must be an object");
  // Only the self-referential locator is excluded, not intent, lanes or Q identity.
  delete envelope.qualificationAdmission;
  wire.trusted_workflow_json = canonical(envelope);
  return canonicalizeJsonValue(wire);
}

function qualificationInputsMatch(requestInputs, observedInputs) {
  const observed = semanticQualificationInputs(observedInputs);
  // GitHub omits optional workflow_dispatch string inputs whose submitted
  // value is empty from the child run's inputs context. Preserve the complete
  // admitted request, then restore only those authenticated empty values for
  // comparison with the effective child-run input shape.
  for (const [key, value] of Object.entries(requestInputs)) {
    if (value === "" && !Object.hasOwn(observed, key)) {
      observed[key] = value;
    }
  }
  return isDeepStrictEqual(requestInputs, observed);
}

export function buildQualificationAdmissionRequest({
  repository,
  candidateSha,
  qualificationSha,
  requestId,
  transportRef,
  reviewed,
  inputs,
}) {
  const request = {
    kind: REQUEST_KIND,
    repository,
    candidateSha,
    qualificationSha,
    requestId,
    transportRef,
    reviewed,
    inputs: semanticQualificationInputs(inputs),
  };
  return validateQualificationAdmissionRequest(request);
}

export function validateQualificationAdmissionRequest(request) {
  exactKeys(
    request,
    [
      "kind",
      "repository",
      "candidateSha",
      "qualificationSha",
      "requestId",
      "transportRef",
      "reviewed",
      "inputs",
    ],
    "qualification request",
  );
  requireValue(
    request.kind === REQUEST_KIND &&
      request.repository === REPOSITORY &&
      SHA.test(request.candidateSha) &&
      request.qualificationSha === request.candidateSha &&
      request.reviewed === true &&
      typeof request.requestId === "string" &&
      /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(request.requestId) &&
      typeof request.transportRef === "string" &&
      new RegExp(
        "^release-ci/" + request.qualificationSha.slice(0, 12) + "-[1-9][0-9]*$",
        "u",
      ).test(request.transportRef),
    "Qualification request must attest the exact reviewed C=Q tuple and transport",
  );
  const inputs = semanticQualificationInputs(request.inputs);
  requireValue(
    inputs.ref === request.candidateSha &&
      inputs.expected_sha === request.candidateSha &&
      isDeepStrictEqual(inputs, request.inputs),
    "Qualification request inputs are not complete canonical C inputs",
  );
  canonical(request);
  return request;
}

export function qualificationAdmissionArtifactName(runId, runAttempt) {
  requireValue(
    Number.isSafeInteger(runId) && runId > 0 && Number.isSafeInteger(runAttempt) && runAttempt > 0,
    "Invalid admission run tuple",
  );
  return "release-qualification-admission-" + runId + "-" + runAttempt;
}

function actorIdentity(actor) {
  requireValue(
    isRecord(actor) &&
      Number.isSafeInteger(actor.id) &&
      actor.id > 0 &&
      typeof actor.login === "string" &&
      /^[A-Za-z0-9][A-Za-z0-9-]{0,38}(?:\[bot\])?$/u.test(actor.login) &&
      ["User", "Bot"].includes(actor.type) &&
      actor.login !== "github-actions[bot]" &&
      actor.id !== 41898282,
    "Qualification admission requires an authenticated operator, not an Actions bot",
  );
  return { id: actor.id, login: actor.login };
}

function verifyActor(repository, actor, runGh) {
  const identity = actorIdentity(actor);
  const permission = api(repository, "collaborators/" + identity.login + "/permission", runGh);
  requireValue(
    ["admin", "write", "maintain"].includes(permission.permission) &&
      permission.user?.id === identity.id &&
      permission.user?.login === identity.login,
    "Qualification operator no longer has repository qualification authority",
  );
  return identity;
}

function readSource(repository, sha, path, runGh) {
  const file = api(repository, "contents/" + path + "?ref=" + sha, runGh);
  requireValue(
    file.type === "file" &&
      file.path === path &&
      file.encoding === "base64" &&
      Number.isSafeInteger(file.size) &&
      file.size > 0 &&
      file.size <= MAX_BYTES &&
      SHA.test(file.sha) &&
      typeof file.content === "string",
    "Invalid immutable qualification source",
  );
  const bytes = Buffer.from(file.content, "base64");
  requireValue(
    bytes.length === file.size &&
      createHash("sha1")
        .update("blob " + bytes.length + "\0")
        .update(bytes)
        .digest("hex") === file.sha,
    "Qualification source bytes differ from the Git blob",
  );
  return bytes;
}

function validateWorkflowInputs(source, inputs) {
  // Share the pre-install scalar declaration parser. Unknown YAML fails closed.
  const text = source.toString("utf8");
  const defaults = releaseChildDispatchInputs(text, []);
  requireValue(
    Object.keys(defaults).length <= 25 &&
      isDeepStrictEqual(
        Object.keys(inputs).toSorted(compareAscii),
        Object.keys(defaults).toSorted(compareAscii),
      ),
    "Qualification request must bind every immutable workflow input",
  );
  const selected = releaseChildDispatchInputs(
    text,
    Object.entries(inputs).flatMap(([key, value]) => ["-f", key + "=" + value]),
  );
  requireValue(
    isDeepStrictEqual(selected, inputs),
    "Qualification workflow input normalization changed",
  );
}

function producerIdentity(value) {
  exactKeys(
    value,
    [
      "repository",
      "runId",
      "runAttempt",
      "workflowPath",
      "workflowEvent",
      "workflowHeadBranch",
      "workflowFullRef",
      "workflowSha",
    ],
    "admission producer",
  );
  requireValue(
    value.repository === REPOSITORY &&
      value.workflowPath === QUALIFICATION_ADMISSION_WORKFLOW &&
      value.workflowEvent === "workflow_dispatch" &&
      SHA.test(value.workflowSha) &&
      Number.isSafeInteger(value.runId) &&
      value.runId > 0 &&
      Number.isSafeInteger(value.runAttempt) &&
      value.runAttempt > 0 &&
      ((value.workflowHeadBranch === "main" && value.workflowFullRef === "refs/heads/main") ||
        (/^release-publish\/[a-f0-9]{12}-[1-9][0-9]*$/u.test(value.workflowHeadBranch) &&
          value.workflowFullRef === "refs/tags/" + value.workflowHeadBranch)),
    "Invalid P admission producer identity",
  );
  return value;
}

function verifyProducer(producer, runGh, completed) {
  producerIdentity(producer);
  verifyReleaseToolingIdentity({
    repository: producer.repository,
    workflowRef: producer.workflowHeadBranch,
    workflowFullRef: producer.workflowFullRef,
    workflowSha: producer.workflowSha,
    runGh,
  });
  const run = api(
    producer.repository,
    "actions/runs/" + producer.runId + "/attempts/" + producer.runAttempt,
    runGh,
  );
  const [path, fullRef] = String(run.path).split("@");
  requireValue(
    run.id === producer.runId &&
      run.run_attempt === producer.runAttempt &&
      run.repository?.full_name === producer.repository &&
      run.head_repository?.full_name === producer.repository &&
      path === producer.workflowPath &&
      (!fullRef || fullRef === producer.workflowFullRef) &&
      run.event === producer.workflowEvent &&
      run.head_sha === producer.workflowSha &&
      run.head_branch === producer.workflowHeadBranch &&
      (completed
        ? run.status === "completed" && run.conclusion === "success"
        : ["in_progress", "queued", "waiting", "pending", "requested"].includes(run.status) &&
          run.conclusion === null),
    "Admission run does not match its exact P workflow attempt",
  );
  return {
    run,
    operator: verifyActor(producer.repository, run.actor, runGh),
    triggeringOperator: verifyActor(producer.repository, run.triggering_actor, runGh),
  };
}

function verifyProducerContract(producer, runGh) {
  const source = readSource(
    producer.repository,
    producer.workflowSha,
    QUALIFICATION_ADMISSION_WORKFLOW,
    runGh,
  ).toString("utf8");
  const markers = [
    ...source.matchAll(/^ {2}RELEASE_QUALIFICATION_ADMISSION_CONTRACT: *([^\r\n]+)$/gmu),
  ];
  requireValue(
    markers.length === 1 &&
      /^(?:"1"|'1'|1)$/u.test(markers[0][1]) &&
      /^ {2}admit_qualification:$/mu.test(source),
    "P does not declare the qualification admission contract",
  );
}

export function produceQualificationAdmission({
  request,
  producer,
  runGh = runQualificationAdmissionGh,
}) {
  validateQualificationAdmissionRequest(request);
  producerIdentity(producer);
  verifyProducerContract(producer, runGh);
  const initial = verifyProducer(producer, runGh, false);
  requireValue(
    initial.run.display_title === "Qualification Admission " + request.requestId,
    "Admission request differs from its workflow dispatch title",
  );
  const workflow = readSource(
    request.repository,
    request.qualificationSha,
    QUALIFICATION_WORKFLOW,
    runGh,
  );
  validateWorkflowInputs(workflow, request.inputs);
  const policyBytes = readSource(
    request.repository,
    request.qualificationSha,
    QUALIFICATION_COVERAGE_PATH,
    runGh,
  );
  const coverage = resolveQualificationCoverage(
    json(policyBytes, "qualification policy"),
    request.inputs,
  );
  const baselinePolicy = qualificationBaselinePolicy(
    request,
    readSource(request.repository, request.qualificationSha, "package.json", runGh),
    readSource(
      request.repository,
      request.qualificationSha,
      QUALIFICATION_BASELINE_POLICY_PATH,
      runGh,
    ),
  );
  const final = verifyProducer(producer, runGh, false);
  requireValue(
    isDeepStrictEqual(initial.operator, final.operator) &&
      isDeepStrictEqual(initial.triggeringOperator, final.triggeringOperator),
    "Admission operator changed while reading Q",
  );
  return {
    kind: RECEIPT_KIND,
    request,
    producer,
    operator: final.operator,
    triggeringOperator: final.triggeringOperator,
    inputsDigest: digest(canonical(request.inputs)),
    workflowSourceDigest: digest(workflow),
    policySourceDigest: digest(policyBytes),
    baselinePolicy,
    coverage,
    coverageDigest: qualificationCoverageSha256(coverage),
  };
}

function validateReceipt(receipt) {
  exactKeys(
    receipt,
    [
      "kind",
      "request",
      "producer",
      "operator",
      "triggeringOperator",
      "inputsDigest",
      "workflowSourceDigest",
      "policySourceDigest",
      "baselinePolicy",
      "coverage",
      "coverageDigest",
    ],
    "admission receipt",
  );
  requireValue(receipt.kind === RECEIPT_KIND, "Unsupported qualification admission receipt");
  validateQualificationAdmissionRequest(receipt.request);
  producerIdentity(receipt.producer);
  validateQualificationBaselinePolicy(receipt.request, receipt.baselinePolicy);
  const coverage = validateQualificationCoverage(receipt.coverage);
  requireValue(
    receipt.inputsDigest === digest(canonical(receipt.request.inputs)) &&
      DIGEST.test(receipt.workflowSourceDigest) &&
      DIGEST.test(receipt.policySourceDigest) &&
      receipt.coverageDigest === qualificationCoverageSha256(coverage) &&
      coverage.profile === receipt.request.inputs.release_profile,
    "Admission request or coverage digest mismatch",
  );
  return receipt;
}

function validateArtifact(descriptor, metadata, run, jobs) {
  validateActionsArtifactBinding({
    expected: { ...descriptor, runStatePolicy: "completed-success" },
    artifactMetadata: metadata,
    workflowRun: { ...run, path: descriptor.workflowPath },
  });
  requireValue(
    Number.isFinite(Date.parse(metadata.expires_at)) &&
      Date.parse(metadata.expires_at) > Date.now(),
    "Qualification admission expired; recover retained original evidence or obtain a new admission, never substitute another run",
  );
  validateActionsArtifactProducerJob({
    expected: {
      ...descriptor,
      runStatePolicy: "same-run-producer-success",
      consumerRunAttempt: descriptor.runAttempt,
      producerJobName: QUALIFICATION_ADMISSION_JOB,
      producerStepName: QUALIFICATION_ADMISSION_UPLOAD,
    },
    workflowJobs: jobs,
  });
  const job = jobs.jobs.find((item) => item.name === QUALIFICATION_ADMISSION_JOB);
  const upload = job.steps.find((item) => item.name === QUALIFICATION_ADMISSION_UPLOAD);
  const created = Date.parse(metadata.created_at);
  requireValue(
    job.conclusion === "success" &&
      Number.isFinite(created) &&
      created >= Date.parse(upload.started_at) &&
      created <= Date.parse(upload.completed_at),
    "Admission artifact was not created by its exact successful upload job",
  );
}

export function resolveQualificationAdmissionDescriptor({
  repository,
  runId,
  runAttempt,
  workflowRef,
  workflowSha,
  runGh = runQualificationAdmissionGh,
}) {
  const producer = producerIdentity({
    repository,
    runId,
    runAttempt,
    workflowPath: QUALIFICATION_ADMISSION_WORKFLOW,
    workflowEvent: "workflow_dispatch",
    workflowHeadBranch: workflowRef,
    workflowFullRef: workflowRef === "main" ? "refs/heads/main" : "refs/tags/" + workflowRef,
    workflowSha,
  });
  verifyProducerContract(producer, runGh);
  const observed = verifyProducer(producer, runGh, true);
  const name = qualificationAdmissionArtifactName(runId, runAttempt);
  const inventory = api(
    repository,
    "actions/runs/" + runId + "/artifacts?name=" + name + "&per_page=100",
    runGh,
  );
  requireValue(
    inventory.total_count === 1 && inventory.artifacts?.length === 1,
    "Qualification admission artifact is missing or ambiguous",
  );
  const artifact = inventory.artifacts[0];
  const descriptor = {
    ...producer,
    artifactId: artifact.id,
    artifactName: name,
    artifactDigest: artifact.digest,
    artifactSizeBytes: artifact.size_in_bytes,
  };
  requireValue(
    Number.isSafeInteger(artifact.size_in_bytes) &&
      artifact.size_in_bytes > 0 &&
      artifact.size_in_bytes <= MAX_ARCHIVE_BYTES,
    "Oversized admission artifact",
  );
  const jobs = api(
    repository,
    "actions/runs/" + runId + "/attempts/" + runAttempt + "/jobs?per_page=100",
    runGh,
  );
  validateArtifact(descriptor, artifact, observed.run, jobs);
  return descriptor;
}

function admissionDescriptorProducer(descriptor, repository) {
  exactKeys(
    descriptor,
    [
      "repository",
      "runId",
      "runAttempt",
      "workflowPath",
      "workflowEvent",
      "workflowHeadBranch",
      "workflowFullRef",
      "workflowSha",
      "artifactId",
      "artifactName",
      "artifactDigest",
      "artifactSizeBytes",
    ],
    "admission descriptor",
  );
  const { artifactId, artifactName, artifactDigest, artifactSizeBytes, ...producer } = descriptor;
  producerIdentity(producer);
  requireValue(
    producer.repository === repository &&
      Number.isSafeInteger(artifactId) &&
      artifactId > 0 &&
      artifactName === qualificationAdmissionArtifactName(producer.runId, producer.runAttempt) &&
      DIGEST.test(artifactDigest) &&
      Number.isSafeInteger(artifactSizeBytes) &&
      artifactSizeBytes > 0 &&
      artifactSizeBytes <= MAX_ARCHIVE_BYTES,
    "Invalid qualification admission artifact identity",
  );
  return producer;
}

// Recheck only live authority after the caller has authenticated the immutable
// receipt. Raw or caller-authored receipt JSON is not an authentication path.
export function revalidateQualificationAdmissionAuthority({
  descriptor,
  admission,
  runGh = runQualificationAdmissionGh,
}) {
  const receipt = validateReceipt(admission);
  const producer = admissionDescriptorProducer(descriptor, receipt.request.repository);
  requireValue(
    isDeepStrictEqual(receipt.producer, producer),
    "Admission authority differs from the authenticated producer",
  );
  const metadata = api(producer.repository, "actions/artifacts/" + descriptor.artifactId, runGh);
  const jobs = api(
    producer.repository,
    "actions/runs/" + producer.runId + "/attempts/" + producer.runAttempt + "/jobs?per_page=100",
    runGh,
  );
  // Finish with the exact P route, original attempt, and current operator grants;
  // no immutable source or archive is reacquired between this check and the write.
  const current = verifyProducer(producer, runGh, true);
  validateArtifact(descriptor, metadata, current.run, jobs);
  requireValue(
    current.run.display_title === "Qualification Admission " + receipt.request.requestId &&
      isDeepStrictEqual(receipt.operator, current.operator) &&
      isDeepStrictEqual(receipt.triggeringOperator, current.triggeringOperator),
    "Admission authority differs from the authenticated operators",
  );
}

export function verifyQualificationAdmission({
  descriptor,
  repository,
  candidateSha,
  qualificationSha,
  workflowRef,
  inputs,
  runGh = runQualificationAdmissionGh,
  downloadArchive = runQualificationAdmissionGh,
}) {
  requireValue(
    repository === REPOSITORY && SHA.test(candidateSha) && candidateSha === qualificationSha,
    "Qualification admission requires the canonical C=Q identity",
  );
  const producer = admissionDescriptorProducer(descriptor, repository);
  const { artifactId, artifactDigest, artifactSizeBytes } = descriptor;
  verifyProducerContract(producer, runGh);
  const initial = verifyProducer(producer, runGh, true);
  const metadata = api(repository, "actions/artifacts/" + artifactId, runGh);
  const jobs = api(
    repository,
    "actions/runs/" + producer.runId + "/attempts/" + producer.runAttempt + "/jobs?per_page=100",
    runGh,
  );
  validateArtifact(descriptor, metadata, initial.run, jobs);
  const archive = downloadArchive(apiArgs(repository, "actions/artifacts/" + artifactId + "/zip"));
  requireValue(
    archive instanceof Uint8Array &&
      archive.byteLength === artifactSizeBytes &&
      digest(archive) === artifactDigest,
    "Admission archive bytes differ from the exact descriptor",
  );
  const files = inspectActionsArtifactZipWithPolicy(archive, {
    expectedEntries: [QUALIFICATION_ADMISSION_FILE],
    maxArchiveBytes: MAX_ARCHIVE_BYTES,
    maxCompressedEntryBytes: () => MAX_ARCHIVE_BYTES,
    maxEntryBytes: () => MAX_BYTES,
    maxExpandedBytes: MAX_BYTES,
  });
  const receipt = validateReceipt(
    json(files.get(QUALIFICATION_ADMISSION_FILE), "qualification admission"),
  );
  const request = receipt.request;
  requireValue(
    isDeepStrictEqual(receipt.producer, producer) &&
      isDeepStrictEqual(receipt.operator, initial.operator) &&
      isDeepStrictEqual(receipt.triggeringOperator, initial.triggeringOperator) &&
      initial.run.display_title === "Qualification Admission " + request.requestId &&
      request.repository === repository &&
      request.candidateSha === candidateSha &&
      request.qualificationSha === qualificationSha &&
      request.transportRef === workflowRef &&
      (inputs === undefined || qualificationInputsMatch(request.inputs, inputs)),
    "Qualification evidence differs from the authenticated operator request",
  );
  const finalMetadata = api(repository, "actions/artifacts/" + artifactId, runGh);
  const final = verifyProducer(producer, runGh, true);
  validateArtifact(descriptor, finalMetadata, final.run, jobs);
  requireValue(
    finalMetadata.expires_at === metadata.expires_at &&
      finalMetadata.created_at === metadata.created_at &&
      isDeepStrictEqual(initial.operator, final.operator) &&
      isDeepStrictEqual(initial.triggeringOperator, final.triggeringOperator),
    "Admission authority changed during acquisition",
  );
  return receipt;
}

function main() {
  requireValue(
    process.argv.length === 2,
    "Qualification admission reads only its authenticated workflow event",
  );
  const env = process.env;
  requireValue(
    env.GITHUB_SERVER_URL === "https://github.com" &&
      env.GITHUB_EVENT_NAME === "workflow_dispatch" &&
      env.GITHUB_REPOSITORY === REPOSITORY,
    "Admission must run in the canonical workflow",
  );
  const event = json(
    readBoundedRegularFile(env.GITHUB_EVENT_PATH, {
      label: "admission workflow event",
      maxBytes: MAX_BYTES,
    }),
    "workflow event",
  );
  requireValue(
    event.inputs?.operation === "admit-qualification" &&
      !event.inputs.publish_inputs &&
      !event.inputs.preparation_request,
    "Admission cannot prepare or publish packages",
  );
  const request = validateQualificationAdmissionRequest(
    json(event.inputs.qualification_request, "qualification request"),
  );
  const producer = producerIdentity({
    repository: env.GITHUB_REPOSITORY,
    runId: Number(env.GITHUB_RUN_ID),
    runAttempt: Number(env.GITHUB_RUN_ATTEMPT),
    workflowPath: QUALIFICATION_ADMISSION_WORKFLOW,
    workflowEvent: env.GITHUB_EVENT_NAME,
    workflowHeadBranch: env.GITHUB_REF_NAME,
    workflowFullRef: env.GITHUB_REF,
    workflowSha: env.GITHUB_WORKFLOW_SHA,
  });
  requireValue(
    env.GITHUB_WORKFLOW_REF ===
      REPOSITORY + "/" + QUALIFICATION_ADMISSION_WORKFLOW + "@" + producer.workflowFullRef,
    "Wrong admission workflow entry point",
  );
  const receipt = produceQualificationAdmission({ request, producer });
  const directory = join(env.RUNNER_TEMP, "qualification-admission");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileSync(join(directory, QUALIFICATION_ADMISSION_FILE), canonical(receipt) + "\n", {
    flag: "wx",
    mode: 0o600,
  });
  appendFileSync(
    env.GITHUB_OUTPUT,
    "artifact_name=" +
      qualificationAdmissionArtifactName(producer.runId, producer.runAttempt) +
      "\n",
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
