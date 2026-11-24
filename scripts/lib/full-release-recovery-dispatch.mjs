// The operator retains one request; receipt owners remain the authorities.
import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { isDeepStrictEqual, stripVTControlCharacters } from "node:util";
import { parse as parseYaml } from "yaml";
import {
  authenticateReceiptRecovery,
  receiptRecoveryPolicyRequest,
  receiptRecoverySourceRequest,
  validateReceiptRecoveryRequest,
  verifyReceiptRecoveryPolicy,
  verifyWaiverPolicyCommit,
} from "../full-release-receipt-recovery.mjs";
import {
  releaseChildSpec,
  validateReleaseChildDispatchBinding,
} from "../full-release-validation-policy.mjs";
import { restoreOriginalPublicationAdmission } from "../release-ci-summary.mjs";
import { readBoundedRegularFile } from "./actions-artifact-archive.mjs";
import { assertRequestPath } from "./full-release-dispatch-request.mts";
import {
  artifactJson,
  discoverPublicationArtifacts,
  one,
  witnessedRun,
} from "./full-release-publication-artifacts.mjs";
import { isWaived, readReleaseValidationWaiversAsync } from "./release-validation-waivers.mjs";

const REPOSITORY = "openclaw/openclaw";
const WORKFLOW = ".github/workflows/full-release-receipt-recovery.yml";
const KIND = "openclaw.full-release-recovery-dispatch/v1";
const MAX_BYTES = 256 * 1024;
function requireValue(value, message) {
  if (!value) {
    throw new Error("Receipt recovery: " + message);
  }
}
export function parseReceiptRecoveryArgs(args) {
  const options = { command: "recover", repository: REPOSITORY, runId: "", json: false };
  const names = {
    "--run": "runId",
    "--workflow-sha": "workflowSha",
    "--request-file": "requestFile",
    "--reconcile-request": "reconcileRequest",
    "--policy-sha": "policySha",
    "--policy-admission-run": "policyAdmissionRun",
  };
  const seen = new Set();
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    requireValue(!seen.has(flag), "duplicate recovery option: " + flag);
    seen.add(flag);
    if (flag === "--prepare-policy-admission") {
      options.preparePolicyAdmission = true;
      continue;
    }
    if (flag === "--json") {
      options.json = true;
      continue;
    }
    requireValue(
      Object.hasOwn(names, flag) && args[index + 1] && !args[index + 1].startsWith("--"),
      "invalid recovery option: " + flag,
    );
    options[names[flag]] = args[++index];
  }
  if (options.reconcileRequest) {
    requireValue(
      !options.runId &&
        !options.workflowSha &&
        !options.requestFile &&
        !options.policySha &&
        !options.policyAdmissionRun &&
        !options.preparePolicyAdmission,
      "--reconcile-request cannot change the retained request",
    );
  } else {
    requireValue(
      /^[1-9][0-9]*$/u.test(options.runId) &&
        /^[a-f0-9]{40}$/u.test(options.workflowSha ?? "") &&
        (options.preparePolicyAdmission ? !options.requestFile : options.requestFile),
      "recover requires --run ORIGINAL --workflow-sha P and a request file unless preparing policy admission",
    );
    requireValue(
      options.preparePolicyAdmission
        ? /^[a-f0-9]{40}$/u.test(options.policySha ?? "") && !options.policyAdmissionRun
        : (!options.policySha && !options.policyAdmissionRun) ||
            (/^[a-f0-9]{40}$/u.test(options.policySha ?? "") &&
              /^[1-9][0-9]*$/u.test(options.policyAdmissionRun ?? "")),
      "policy recovery requires --policy-sha Q and --policy-admission-run ID (or --prepare-policy-admission)",
    );
  }
  return options;
}

// A rerun can remove parent artifacts. Read only the successful runner input
// group; the admission owner still authenticates its descriptor and every input.
async function discoverOriginalAdmission(parent, jobs, client) {
  const workflow = parseYaml(client.getWorkflowSource(parent.head_sha));
  const definition = one(
    (workflow.jobs?.resolve_target?.steps ?? []).filter(
      (step) => step.env?.QUALIFICATION_ADMISSION_JSON && step.env.QUALIFICATION_INPUTS_JSON,
    ),
    "frozen admission input step",
  );
  const job = one(
    jobs.filter((entry) => entry.name === workflow.jobs.resolve_target.name),
    "original resolve job",
  );
  const step = one(
    job.steps.filter((entry) => entry.name === definition.name),
    "original admission input step",
  );
  requireValue(
    step.status === "completed" && step.conclusion === "success",
    "original admission inputs did not succeed",
  );
  const log = await client.getJobLog(job.id);
  requireValue(
    typeof log === "string" && Buffer.byteLength(log) <= 8 * 1024 * 1024,
    "resolve log exceeds limit",
  );
  const groups = [
    ...stripVTControlCharacters(log).matchAll(
      /^(\d{4}-\d\d-\d\dT\S+Z) ##\[group\]Run [\s\S]*?^\d{4}-\d\d-\d\dT\S+Z ##\[endgroup\]/gmu,
    ),
  ].filter(
    (match) =>
      Date.parse(match[1]) >= Date.parse(step.started_at) &&
      Date.parse(match[1]) < Date.parse(step.completed_at) + 1000 &&
      match[0].includes("  QUALIFICATION_INPUTS_JSON: "),
  );
  const header = one(groups, "original admission runner inputs")[0]
    .replace(/^\d{4}-\d\d-\d\dT\S+Z /gmu, "")
    .split("\nenv:\n");
  requireValue(header.length === 2, "original admission environment differs");
  const env = {};
  let key;
  for (const line of header[1].split("\n").slice(0, -1)) {
    const match = /^ {2}([A-Z][A-Z0-9_]*): (.*)$/u.exec(line);
    if (match) {
      requireValue(!Object.hasOwn(env, match[1]), "duplicate admission input");
      key = match[1];
      env[key] = match[2];
    } else {
      requireValue(key, "invalid admission environment");
      env[key] += "\n" + line;
    }
  }
  const descriptor = JSON.parse(env.QUALIFICATION_ADMISSION_JSON);
  const admission = await client.verifyQualificationAdmission({
    descriptor,
    repository: REPOSITORY,
    candidateSha: env.CANDIDATE_SHA,
    qualificationSha: parent.head_sha,
    workflowRef: parent.head_branch,
    inputs: JSON.parse(env.QUALIFICATION_INPUTS_JSON),
  });
  return {
    ...receiptRecoverySourceRequest(admission, {
      runId: String(parent.id),
      runAttempt: 1,
      fullRef: "refs/heads/" + parent.head_branch,
      sha: parent.head_sha,
    }),
    qualificationAdmission: descriptor,
  };
}

async function discoverOriginalQualification(runId, client) {
  const parent = await client.getRunAttempt(runId, 1);
  requireValue(
    String(parent.id) === runId &&
      parent.run_attempt === 1 &&
      parent.repository?.full_name === REPOSITORY &&
      parent.head_repository?.full_name === REPOSITORY &&
      parent.event === "workflow_dispatch" &&
      String(parent.path).split("@")[0] === ".github/workflows/full-release-validation.yml",
    "original parent identity differs",
  );
  const jobs = await client.getRunAttemptJobs(runId, 1, { requireComplete: true });
  const inventory = await client.getRunArtifacts(runId);
  const sourceName = "full-release-source-admission-parent-" + runId + "-1";
  const source = inventory.some((entry) => entry.name === sourceName)
    ? (await artifactJson(client, parent, sourceName, "publication-source-admission.json")).value
    : await discoverOriginalAdmission(parent, jobs, client);
  requireValue(source.qualificationAdmission, "original source has no qualification admission");
  const admission = await client.verifyQualificationAdmission({
    descriptor: source.qualificationAdmission,
    repository: REPOSITORY,
    candidateSha: source.candidateSha,
    qualificationSha: parent.head_sha,
    workflowRef: parent.head_branch,
  });
  return { parent, jobs, inventory, source, admission };
}

export async function discoverReceiptRecoveryRequest(
  runId,
  workflowSha,
  client,
  policyOptions = {},
) {
  requireValue(
    /^[1-9][0-9]*$/u.test(runId) && /^[a-f0-9]{40}$/u.test(workflowSha),
    "original run and exact P are required",
  );
  const { parent, jobs, inventory, source, admission } = await discoverOriginalQualification(
    runId,
    client,
  );
  let plan;
  if (inventory.some((entry) => entry.name === "full-release-execution-plan-" + runId)) {
    // An invalid existing plan is not a reason to fall back to discovery.
    ({ plan } = await restoreOriginalPublicationAdmission({ request: source, client }));
  }
  const descriptors = await discoverPublicationArtifacts(
    parent,
    source,
    jobs,
    client,
    plan?.candidate,
  );
  const requestId = randomUUID();
  let policyQualification;
  if (policyOptions.policyAdmissionRun) {
    const admissionRunId = Number(policyOptions.policyAdmissionRun);
    const run = await client.getRun(policyOptions.policyAdmissionRun);
    requireValue(
      Number.isSafeInteger(admissionRunId) && run.id === admissionRunId && run.run_attempt === 1,
      "waiver policy admission must identify its current first attempt",
    );
    policyQualification = {
      sha: policyOptions.policySha,
      admission: client.resolveQualificationAdmissionDescriptor({
        repository: REPOSITORY,
        runId: admissionRunId,
        runAttempt: 1,
        workflowRef: run.head_branch,
        workflowSha: run.head_sha,
      }),
    };
  }
  const policy = await verifyReceiptRecoveryPolicy(
    { requestId, policyQualification },
    admission,
    client,
  );
  const waivers =
    policy?.waiverPolicy ??
    (await readReleaseValidationWaiversAsync((path) =>
      client.getWorkflowSource(parent.head_sha, path),
    ));
  const scope = {
    targetSha: source.candidateSha,
    targetVersion: admission.baselinePolicy.candidateVersion,
  };
  const children = {};
  for (const coverage of admission.coverage.children) {
    const role = coverage.key;
    if (isWaived({ ...scope, childRole: role }, waivers)) {
      continue;
    }
    if (plan?.childReuse?.[role]) {
      children[role] = plan.childReuse[role];
      continue;
    }
    const { run, log, reused } = await witnessedRun(
      client,
      jobs,
      coverage.parentJobName,
      releaseChildSpec(role).workflow,
      true,
    );
    const receipt = await artifactJson(
      client,
      run,
      "full-release-child-evidence-" +
        source.candidateSha +
        "-" +
        role +
        "-" +
        run.id +
        "-" +
        run.run_attempt,
      "full-release-child-evidence.json",
    );
    const value = receipt.value;
    children[role] = {
      repository: REPOSITORY,
      role,
      targetSha: value.targetSha,
      runId: String(run.id),
      runAttempt: run.run_attempt,
      workflowSha: value.workflowSha,
      workflowRef: value.workflowRef,
      displayTitle: value.displayTitle,
      sourceParentRunId: value.sourceParentRunId,
      sourceParentAttempt: value.sourceParentAttempt,
      inputs: reused
        ? Object.fromEntries(
            Object.entries(value.inputs)
              .filter(([key, input]) => key !== "dispatch_id" && input !== "")
              .map(([key, input]) => [key, String(input)]),
          )
        : value.inputs,
      receiptSha256: value.sha256,
      url: "https://github.com/" + REPOSITORY + "/actions/runs/" + run.id,
      artifact: {
        id: String(receipt.metadata.id),
        name: receipt.metadata.name,
        digest: receipt.metadata.digest,
        expiresAt: receipt.metadata.expires_at,
        sizeInBytes: receipt.metadata.size_in_bytes,
      },
    };
    if (reused) {
      // Reconstruct exactly what the original reuse owner selected, then bind it
      // to that parent's canonical adoption digest. Final authentication still
      // validates the receipt, origin, live attempts, and admitted inputs.
      validateReleaseChildDispatchBinding({
        child: { key: role, runId: String(run.id) },
        childReuse: children[role],
        coveragePolicy: source.coverage?.coverage_policy,
        log,
        plannedRunAttempt: 1,
        repository: REPOSITORY,
        targetSha: source.candidateSha,
      });
    }
  }
  // The qualification remains attempt 1 even after a failed reseal. Pin the
  // separately observed latest attempt so another rerun invalidates this request.
  const currentParent = await client.getRun(runId);
  requireValue(
    String(currentParent.id) === runId &&
      currentParent.head_sha === parent.head_sha &&
      Number.isSafeInteger(currentParent.run_attempt) &&
      currentParent.run_attempt >= 1 &&
      currentParent.status === "completed" &&
      ["success", "failure"].includes(currentParent.conclusion),
    "current parent must be a terminal attempt of the original qualification",
  );
  return validateReceiptRecoveryRequest({
    ...(policyQualification && { policyQualification }),
    schema: "openclaw.full-release-receipt-recovery/v1",
    requestId,
    workflowSha,
    repository: REPOSITORY,
    originalParent: { runId, runAttempt: 1, currentRunAttempt: currentParent.run_attempt },
    qualificationAdmission: source.qualificationAdmission,
    candidateBinding: descriptors.candidate,
    children,
    publicationArtifacts: descriptors.publicationArtifacts,
  });
}

function validateRecord(record) {
  requireValue(
    record?.kind === KIND &&
      ["prepared", "attempted"].includes(record.phase) &&
      Object.keys(record).toSorted().join(",") === "kind,phase,request",
    "invalid retained recovery record",
  );
  validateReceiptRecoveryRequest(record.request);
  requireValue(
    /^[a-f0-9]{40}$/u.test(record.request.workflowSha),
    "retained request omitted exact P",
  );
  return record;
}
function readRecord(path) {
  assertRequestPath(path);
  const bytes = readBoundedRegularFile(path, { maxBytes: MAX_BYTES, label: "Recovery request" });
  const record = validateRecord(JSON.parse(bytes.toString("utf8")));
  requireValue(
    bytes.equals(Buffer.from(JSON.stringify(record) + "\n")),
    "retained request is not canonical JSON",
  );
  return record;
}
function retain(path, record, previous) {
  validateRecord(record);
  const bytes = JSON.stringify(record) + "\n";
  requireValue(Buffer.byteLength(bytes) <= MAX_BYTES, "retained request exceeds limit");
  assertRequestPath(path);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  assertRequestPath(path);
  const temporary = path + "." + randomUUID() + ".tmp";
  const fd = openSync(temporary, "wx", 0o600);
  try {
    try {
      writeFileSync(fd, bytes);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    if (previous) {
      requireValue(isDeepStrictEqual(readRecord(path), previous), "retained request changed");
      renameSync(temporary, path);
    } else {
      linkSync(temporary, path);
    }
    const directory = openSync(dirname(path), "r");
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
  } finally {
    rmSync(temporary, { force: true });
  }
}

export async function reconcileReceiptRecovery(path, client) {
  const { request, phase } = readRecord(path);
  const runs = await client.listRecoveryRuns();
  requireValue(Array.isArray(runs) && runs.length <= 100, "recovery run inventory exceeds limit");
  const matches = runs.filter(
    (run) => run.display_title === "Receipt Recovery " + request.requestId,
  );
  requireValue(matches.length <= 1, "ambiguous recovery runs; never redispatch");
  const run = matches[0];
  if (run) {
    requireValue(
      run.head_sha === request.workflowSha &&
        run.head_branch === "main" &&
        run.event === "workflow_dispatch" &&
        String(run.path).split("@")[0] === WORKFLOW &&
        run.run_attempt === 1 &&
        run.repository?.full_name === REPOSITORY &&
        run.head_repository?.full_name === REPOSITORY &&
        Number.isSafeInteger(run.id) &&
        run.id > 0,
      "observed recovery identity differs; never redispatch",
    );
  }
  let requestAuthenticated = false;
  if (run) {
    const inventory = await client.getRunArtifacts(String(run.id));
    const name = "full-release-recovery-request-" + run.id + "-1";
    if (inventory.some((entry) => entry.name === name)) {
      const workflow = client.getWorkflowSource(request.workflowSha, WORKFLOW);
      requireValue(
        /^ {2}FULL_RELEASE_RECEIPT_RECOVERY_REQUEST_CONTRACT: ["']?1["']?$/mu.test(workflow),
        "P lacks request witness contract",
      );
      const witness = await artifactJson(client, run, name, "request.json");
      requireValue(
        witness.bytes.equals(Buffer.from(JSON.stringify(request) + "\n")),
        "recovery request witness differs from retained bytes",
      );
      const jobs = await client.getRunAttemptJobs(String(run.id), 1, { requireComplete: true });
      const job = one(
        jobs.filter((entry) => entry.name === "Recover original qualification receipts"),
        "recovery request job",
      );
      const retainStep = one(
        job.steps.filter((step) => step.name === "Retain exact recovery request"),
        "retain request step",
      );
      const uploadStep = one(
        job.steps.filter((step) => step.name === "Upload exact recovery request"),
        "upload request step",
      );
      const created = Date.parse(witness.metadata.created_at);
      requireValue(
        job.run_attempt === 1 &&
          retainStep.conclusion === "success" &&
          uploadStep.conclusion === "success" &&
          retainStep.number < uploadStep.number &&
          Date.parse(retainStep.completed_at) <= Date.parse(uploadStep.started_at) &&
          Date.parse(uploadStep.started_at) <= created &&
          created <= Date.parse(uploadStep.completed_at) &&
          witness.metadata.workflow_run?.id === run.id &&
          witness.metadata.workflow_run?.head_sha === request.workflowSha &&
          witness.metadata.workflow_run?.head_branch === "main",
        "request witness producer or upload ordering differs",
      );
      requestAuthenticated = true;
    }
  }
  let authenticated = false;
  if (run?.status === "completed" && run.conclusion === "success") {
    const { manifest, artifact } = await client.loadManifest(String(run.id), 1);
    requireValue(
      isDeepStrictEqual(manifest.receiptRecovery, request),
      "completed recovery request differs from retained bytes",
    );
    await authenticateReceiptRecovery({ manifest, artifact, run, client });
    const current = await client.getRun(String(run.id));
    requireValue(
      current.id === run.id &&
        current.run_attempt === 1 &&
        current.head_sha === request.workflowSha &&
        current.status === "completed" &&
        current.conclusion === "success",
      "recovery attempt changed during authentication",
    );
    authenticated = true;
  }
  if (run) {
    const current = await client.getRun(String(run.id));
    requireValue(
      current.id === run.id &&
        current.run_attempt === 1 &&
        current.head_sha === request.workflowSha,
      "recovery attempt changed during observation",
    );
  }
  return {
    requestAuthenticated,
    action: authenticated
      ? "recovery-authenticated"
      : requestAuthenticated
        ? "recovery-observed"
        : "recovery-unconfirmed",
    authenticated,
    phase,
    requestId: request.requestId,
    workflowSha: request.workflowSha,
    runId: run ? String(run.id) : null,
    status: run?.status ?? null,
    conclusion: run?.conclusion ?? null,
    nextCommand: "pnpm frv recover --reconcile-request " + JSON.stringify(path),
    complete: authenticated,
  };
}

export async function dispatchReceiptRecovery(options, client) {
  if (options.reconcileRequest) {
    return reconcileReceiptRecovery(options.reconcileRequest, client);
  }
  if (options.preparePolicyAdmission) {
    const { parent, admission } = await discoverOriginalQualification(options.runId, client);
    requireValue(
      parent.status === "completed" && ["success", "failure"].includes(parent.conclusion),
      "original parent is not terminal",
    );
    await verifyWaiverPolicyCommit(client, parent.head_sha, options.policySha);
    return {
      qualificationRequest: receiptRecoveryPolicyRequest(
        admission,
        options.policySha,
        randomUUID(),
      ),
    };
  }
  assertRequestPath(options.requestFile);
  if (existsSync(options.requestFile)) {
    const retained = readRecord(options.requestFile);
    requireValue(
      retained.request.originalParent.runId === options.runId &&
        retained.request.workflowSha === options.workflowSha &&
        retained.request.policyQualification?.sha === options.policySha &&
        retained.request.policyQualification?.admission.runId ===
          (options.policyAdmissionRun ? Number(options.policyAdmissionRun) : undefined),
      "existing request differs from requested original run, P or policy admission",
    );
    return reconcileReceiptRecovery(options.requestFile, client);
  }
  const request = await discoverReceiptRecoveryRequest(
    options.runId,
    options.workflowSha,
    client,
    options,
  );
  const wire = JSON.stringify({ ref: "main", inputs: { request: JSON.stringify(request) } });
  requireValue(
    Buffer.byteLength(JSON.stringify({ request: JSON.stringify(request) })) <= 65_535,
    "request exceeds GitHub workflow input limit",
  );
  const prepared = { kind: KIND, phase: "prepared", request };
  retain(options.requestFile, prepared);
  const workflow = client.getWorkflowSource(request.workflowSha, WORKFLOW);
  requireValue(
    /^ {2}FULL_RELEASE_RECEIPT_RECOVERY_CONTRACT: ["']?1["']?$/mu.test(workflow) &&
      workflow.includes("fromJSON(inputs.request).requestId") &&
      /^ {2}FULL_RELEASE_RECEIPT_RECOVERY_REQUEST_CONTRACT: ["']?1["']?$/mu.test(workflow),
    "P lacks retained recovery dispatch identity",
  );
  // Authenticate live admission here; the workflow owns full receipt verification.
  // Repeating that multi-minute scan locally makes the selected main SHA go stale.
  const parent = await client.getRunAttempt(request.originalParent.runId, 1);
  const originalAdmission = await client.verifyQualificationAdmission({
    descriptor: request.qualificationAdmission,
    repository: request.repository,
    candidateSha: request.candidateBinding.request.targetSha,
    qualificationSha: request.candidateBinding.request.toolingSha,
    workflowRef: parent.head_branch,
  });
  await verifyReceiptRecoveryPolicy(request, originalAdmission, client);
  const ref = await client.getRef("refs/heads/main");
  requireValue(
    ref.object?.type === "commit" && ref.object.sha === request.workflowSha,
    "main moved from exact P; retained request was not sent",
  );
  // A crash after this durable transition is uncertain, including before send.
  // An empty run inventory never proves non-execution.
  retain(options.requestFile, { ...prepared, phase: "attempted" }, prepared);
  try {
    await client.postRecovery(wire);
  } catch {
    /* observation owns uncertain transport outcomes */
  }
  return reconcileReceiptRecovery(options.requestFile, client);
}
