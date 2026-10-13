// Retained request and its admission transition share one atomic owner. The CLI
// supplies its selected GitHub transport; only that CLI initiates dispatch.
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { decodePublicationDispatchEnvelope } from "../full-release-publication-contract.mjs";
import {
  buildQualificationAdmissionRequest,
  semanticQualificationInputs,
  validateQualificationAdmissionRequest,
  verifyQualificationAdmission,
  resolveQualificationAdmissionDescriptor,
} from "../release-qualification-admission.mjs";
import { readBoundedRegularFile } from "./actions-artifact-archive.mjs";
import { isRecord as isJsonRecord } from "./record-shared.mjs";
import { sleep } from "./sleep.mjs";

const REPOSITORY = "openclaw/openclaw";
const TRUSTED_WORKFLOW_PATH = ".github/workflows/full-release-validation.yml";
const ADMISSION_WORKFLOW = "openclaw-release-prepare.yml";
export const REQUEST_KIND = "openclaw.full-release-dispatch/v1";
export const CANDIDATE_REQUEST_KIND = "openclaw.full-release-dispatch/v2";
export const MAX_REQUEST_BYTES = 128 * 1024;
const TRUSTED_WORKFLOW_TAG_PATTERN = /^release-publish\/([a-f0-9]{12})-[1-9][0-9]*$/u;
const SHA_PATTERN = /^[a-f0-9]{40}$/u;

type QualificationDispatchClient = {
  readApi: (endpoint: string, fields?: string[]) => string;
  postApi: (args: string[]) => string;
  httpStatus: (response: string) => number;
};
function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}
function requireDispatch(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}
function exactKeys(value: unknown, keys: string[]): value is Record<string, unknown> {
  return isJsonRecord(value) && isDeepStrictEqual(Object.keys(value).toSorted(), keys.toSorted());
}

export type DispatchInputs = Record<string, string | boolean | number>;
export type DispatchRun = { id: number; attempt: number };
export type DispatchRequest = {
  id: string;
  host: "github.com";
  repository: typeof REPOSITORY;
  workflowId: number;
  workflowPath: typeof TRUSTED_WORKFLOW_PATH;
  event: "workflow_dispatch";
  workflowSha: string;
  trustedWorkflowRef: string;
  targetSha: string;
  targetVersion: string;
  targetContextRef: string;
  workflowRef: string;
  wireInputs: Record<string, string>;
  inputs: DispatchInputs;
  effectiveSoak: boolean;
};
export type QualificationAdmissionDispatch = {
  request: ReturnType<typeof buildQualificationAdmissionRequest>;
  workflowSha: string;
  workflowRef: string;
  workflowId: number;
  phase: "prepared" | "attempted" | "observed" | "rejected";
  run: DispatchRun | null;
  descriptor: Record<string, unknown> | null;
};
export type DispatchRecord = {
  kind: typeof REQUEST_KIND | typeof CANDIDATE_REQUEST_KIND;
  admission?: QualificationAdmissionDispatch;
  request: DispatchRequest;
  phase: "prepared" | "attempted" | "observed" | "rejected";
  refs: { workflow: "intended" | "uncertain" | "created" };
  error: "none" | "transport" | "unclassified" | "http-rejection";
  run: DispatchRun | null;
};

export function dispatchInputsDigest(inputs: DispatchInputs): string {
  const wireInputs = Object.fromEntries(
    Object.keys(inputs)
      .filter((key) => String(inputs[key]) !== "")
      .toSorted()
      .map((key) => [key, String(inputs[key])]),
  );
  return `sha256:${createHash("sha256").update(JSON.stringify(wireInputs)).digest("hex")}`;
}

export function formatDispatchSelection(
  request: Pick<DispatchRequest, "targetSha" | "workflowSha" | "inputs" | "effectiveSoak">,
): string {
  const { inputs } = request;
  // Waiver values remain in the private request; operator output records selection only.
  const waiver = inputs.telegram_waiver ? "selected (redacted)" : "omitted";
  return `Frozen validation selection: candidate=${request.targetSha} tooling=${request.workflowSha} release_profile=${inputs.release_profile} rerun_group=${inputs.rerun_group} soak=${request.effectiveSoak} telegram_waiver=${waiver}`;
}

function validateDispatchRecord(value: unknown): asserts value is DispatchRecord {
  requireDispatch(
    exactKeys(value, [
      "kind",
      "request",
      "phase",
      "refs",
      "error",
      "run",
      ...(isJsonRecord(value) && value.kind === CANDIDATE_REQUEST_KIND ? ["admission"] : []),
    ]) &&
      [REQUEST_KIND, CANDIDATE_REQUEST_KIND].includes(stringValue(value.kind)) &&
      ["prepared", "attempted", "observed", "rejected"].includes(stringValue(value.phase)) &&
      ["none", "transport", "unclassified", "http-rejection"].includes(stringValue(value.error)),
    "Invalid retained dispatch record",
  );
  const request = value.request;
  requireDispatch(
    exactKeys(request, [
      "id",
      "host",
      "repository",
      "workflowId",
      "workflowPath",
      "event",
      "workflowSha",
      "trustedWorkflowRef",
      "targetSha",
      "targetVersion",
      "targetContextRef",
      "workflowRef",
      "wireInputs",
      "inputs",
      "effectiveSoak",
    ]) &&
      typeof request.id === "string" &&
      /^[a-f0-9-]{36}$/u.test(request.id) &&
      request.host === "github.com" &&
      request.repository === REPOSITORY &&
      request.workflowPath === TRUSTED_WORKFLOW_PATH &&
      request.event === "workflow_dispatch" &&
      Number.isSafeInteger(request.workflowId) &&
      Number(request.workflowId) > 0 &&
      typeof request.workflowSha === "string" &&
      SHA_PATTERN.test(request.workflowSha) &&
      typeof request.targetSha === "string" &&
      SHA_PATTERN.test(request.targetSha) &&
      typeof request.targetVersion === "string" &&
      /^[0-9]{4}\.[0-9]+\.[0-9]+(?:-.+)?$/u.test(request.targetVersion) &&
      typeof request.targetContextRef === "string" &&
      typeof request.trustedWorkflowRef === "string" &&
      ((value.kind === CANDIDATE_REQUEST_KIND &&
        request.trustedWorkflowRef === "candidate" &&
        request.targetSha === request.workflowSha) ||
        request.trustedWorkflowRef === "main" ||
        TRUSTED_WORKFLOW_TAG_PATTERN.test(request.trustedWorkflowRef)) &&
      typeof request.workflowRef === "string" &&
      new RegExp(`^release-ci/${request.workflowSha.slice(0, 12)}-[0-9]+$`, "u").test(
        request.workflowRef,
      ) &&
      isJsonRecord(request.wireInputs) &&
      isJsonRecord(request.inputs) &&
      isDeepStrictEqual(
        Object.keys(request.wireInputs).toSorted(),
        Object.keys(request.inputs).toSorted(),
      ),
    "Invalid retained dispatch request identity",
  );
  const wireInputs: Record<string, string> = {};
  for (const [key, input] of Object.entries(request.inputs)) {
    requireDispatch(
      /^[a-z][a-z0-9_]*$/u.test(key) &&
        (typeof input === "string" ||
          typeof input === "boolean" ||
          (typeof input === "number" && Number.isFinite(input))) &&
        request.wireInputs[key] === String(input),
      "Invalid retained dispatch inputs",
    );
    wireInputs[key] = String(input);
  }
  requireDispatch(
    request.inputs.ref === request.targetSha &&
      request.inputs.expected_sha === request.targetSha &&
      (request.targetContextRef === request.targetSha
        ? !request.inputs.target_context_ref
        : request.inputs.target_context_ref === request.targetContextRef) &&
      request.effectiveSoak ===
        (request.inputs.run_release_soak === true ||
          request.inputs.release_profile === "stable" ||
          request.inputs.release_profile === "full"),
    "Retained dispatch selection does not match its identity",
  );
  if (request.inputs.trusted_workflow_json) {
    requireDispatch(
      typeof request.inputs.trusted_workflow_json === "string",
      "Invalid retained tooling input",
    );
    const supplied = JSON.parse(request.inputs.trusted_workflow_json);
    const enveloped = isJsonRecord(supplied) && Object.hasOwn(supplied, "trustedWorkflow");
    const identity = enveloped
      ? decodePublicationDispatchEnvelope(request.inputs.trusted_workflow_json).trustedWorkflow
      : supplied;
    requireDispatch(
      !enveloped ||
        (!Object.hasOwn(request.inputs, "validation_purpose") &&
          !Object.hasOwn(request.inputs, "publication_selection_json") &&
          !Object.hasOwn(request.inputs, "extension_test_exclude_patterns_json")),
      "Retained dispatch contains conflicting source intent representations",
    );
    requireDispatch(
      typeof request.inputs.trusted_workflow_json === "string" &&
        isDeepStrictEqual(identity, {
          fullRef:
            request.trustedWorkflowRef === "candidate"
              ? `refs/heads/${request.workflowRef}`
              : request.trustedWorkflowRef === "main"
                ? "refs/heads/main"
                : `refs/tags/${request.trustedWorkflowRef}`,
          ref:
            request.trustedWorkflowRef === "candidate"
              ? request.workflowRef
              : request.trustedWorkflowRef,
          sha: request.workflowSha,
        }),
      "Retained trusted workflow identity changed",
    );
  }
  if (value.kind === CANDIDATE_REQUEST_KIND) {
    requireDispatch(
      request.trustedWorkflowRef === "candidate" && request.workflowSha === request.targetSha,
      "Candidate request cannot change its qualification mode or C=Q identity",
    );
    const admission = value.admission;
    requireDispatch(
      exactKeys(admission, [
        "request",
        "workflowSha",
        "workflowRef",
        "workflowId",
        "phase",
        "run",
        "descriptor",
      ]) &&
        SHA_PATTERN.test(stringValue(admission.workflowSha)) &&
        (admission.workflowRef === "main" ||
          TRUSTED_WORKFLOW_TAG_PATTERN.test(stringValue(admission.workflowRef))) &&
        Number.isSafeInteger(admission.workflowId) &&
        Number(admission.workflowId) > 0 &&
        ["prepared", "attempted", "observed", "rejected"].includes(stringValue(admission.phase)),
      "Invalid retained qualification admission",
    );
    const admitted = validateQualificationAdmissionRequest(admission.request);
    requireDispatch(
      admitted.requestId === request.id &&
        admitted.candidateSha === request.targetSha &&
        admitted.qualificationSha === request.workflowSha &&
        admitted.transportRef === request.workflowRef &&
        isDeepStrictEqual(admitted.inputs, semanticQualificationInputs(wireInputs)),
      "Retained qualification admission differs from the frozen request",
    );
    requireDispatch(
      admission.run === null ||
        (exactKeys(admission.run, ["id", "attempt"]) &&
          Number.isSafeInteger(admission.run.id) &&
          Number(admission.run.id) > 0 &&
          Number.isSafeInteger(admission.run.attempt) &&
          Number(admission.run.attempt) > 0),
      "Invalid retained admission run",
    );
    const locator = decodePublicationDispatchEnvelope(
      String(request.inputs.trusted_workflow_json),
    ).qualificationAdmission;
    requireDispatch(
      admission.phase === "observed"
        ? admission.run !== null &&
            isJsonRecord(admission.descriptor) &&
            isDeepStrictEqual(locator, admission.descriptor)
        : admission.descriptor === null && locator === undefined,
      "Retained admission locator changed",
    );
    requireDispatch(
      value.phase === "prepared" || admission.phase === "observed",
      "Qualification cannot dispatch before authenticated admission",
    );
  }
  requireDispatch(
    exactKeys(value.refs, ["workflow"]) &&
      Object.values(value.refs).every((state) =>
        ["intended", "uncertain", "created"].includes(stringValue(state)),
      ) &&
      (value.run === null ||
        (exactKeys(value.run, ["id", "attempt"]) &&
          Number.isSafeInteger(value.run.id) &&
          Number(value.run.id) > 0 &&
          Number.isSafeInteger(value.run.attempt) &&
          Number(value.run.attempt) > 0)) &&
      (value.phase === "observed" ? value.run !== null : value.run === null) &&
      (value.phase !== "rejected" || value.error === "http-rejection"),
    "Invalid retained dispatch outcome",
  );
}

export function assertRequestPath(path: string) {
  let current = resolve(path);
  while (true) {
    try {
      const info = lstatSync(current);
      requireDispatch(!info.isSymbolicLink(), "Request path must not contain symlinks");
      if (current === resolve(path)) {
        requireDispatch(
          info.isFile() && (info.mode & 0o077) === 0,
          "Request must be a private regular file",
        );
      } else {
        requireDispatch(info.isDirectory(), "Request parent must be a directory");
      }
    } catch (error) {
      if (!isJsonRecord(error) || error.code !== "ENOENT") {
        throw error;
      }
    }
    const parent = dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
}

export function readDispatchRecord(path: string): DispatchRecord {
  assertRequestPath(path);
  const bytes = readBoundedRegularFile(path, {
    maxBytes: MAX_REQUEST_BYTES,
    label: "Retained dispatch request",
  });
  const value: unknown = JSON.parse(bytes.toString("utf8"));
  requireDispatch(
    bytes.equals(Buffer.from(`${JSON.stringify(value)}\n`)),
    "Retained request is not complete canonical JSON",
  );
  validateDispatchRecord(value);
  return value;
}

export function retainDispatchRecord(
  path: string,
  record: DispatchRecord,
  previous?: DispatchRecord,
) {
  validateDispatchRecord(record);
  const bytes = `${JSON.stringify(record)}\n`;
  requireDispatch(
    Buffer.byteLength(bytes) <= MAX_REQUEST_BYTES,
    "Dispatch request exceeds its byte limit",
  );
  assertRequestPath(path);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  assertRequestPath(path);
  const temporary = `${path}.${randomUUID()}.tmp`;
  const descriptor = openSync(temporary, "wx", 0o600);
  try {
    try {
      writeFileSync(descriptor, bytes);
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    if (previous) {
      requireDispatch(
        isDeepStrictEqual(readDispatchRecord(path), previous),
        "Retained request changed during dispatch",
      );
      renameSync(temporary, path);
    } else {
      // A fully written exclusive claim prevents a second caller from issuing the POST.
      linkSync(temporary, path);
      unlinkSync(temporary);
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

export function observeQualificationAdmission(
  record: DispatchRecord,
  client: QualificationDispatchClient,
) {
  const admission = record.admission;
  requireDispatch(
    admission && admission.phase !== "prepared" && admission.phase !== "rejected",
    "No qualification admission POST is available to reconcile",
  );
  if (admission.phase === "observed") {
    requireDispatch(
      admission.run &&
        admission.descriptor &&
        admission.descriptor.runId === admission.run.id &&
        admission.descriptor.runAttempt === admission.run.attempt,
      "Retained admission attempt differs from its artifact",
    );
    const authenticated = verifyQualificationAdmission({
      descriptor: admission.descriptor,
      repository: REPOSITORY,
      candidateSha: record.request.targetSha,
      qualificationSha: record.request.workflowSha,
      workflowRef: record.request.workflowRef,
      inputs: record.request.wireInputs,
    });
    requireDispatch(
      isDeepStrictEqual(authenticated.request, admission.request),
      "Retained admission differs from the original frozen request",
    );
    return { descriptor: admission.descriptor, run: admission.run };
  }
  const inventory: unknown = JSON.parse(
    client.readApi("repos/" + REPOSITORY + "/actions/workflows/" + admission.workflowId + "/runs", [
      "-f",
      "branch=" + admission.workflowRef,
      "-f",
      "event=workflow_dispatch",
      "-f",
      "per_page=100",
    ]),
  );
  requireDispatch(
    isJsonRecord(inventory) && Array.isArray(inventory.workflow_runs),
    "Invalid admission run inventory",
  );
  const matches = inventory.workflow_runs.filter(
    (run) =>
      isJsonRecord(run) && run.display_title === "Qualification Admission " + record.request.id,
  );
  requireDispatch(
    matches.length <= 1,
    "Admission request has ambiguous workflow runs; do not redispatch",
  );
  if (!matches.length) {
    return null;
  }
  const run = matches[0];
  requireDispatch(
    isJsonRecord(run) &&
      run.workflow_id === admission.workflowId &&
      run.head_sha === admission.workflowSha &&
      run.head_branch === admission.workflowRef &&
      run.event === "workflow_dispatch" &&
      run.run_attempt === 1 &&
      isJsonRecord(run.repository) &&
      run.repository.full_name === REPOSITORY &&
      isJsonRecord(run.head_repository) &&
      run.head_repository.full_name === REPOSITORY &&
      String(run.path).split("@", 1)[0] === ".github/workflows/" + ADMISSION_WORKFLOW &&
      Number.isSafeInteger(run.id) &&
      Number(run.id) > 0 &&
      (!admission.run || admission.run.id === run.id),
    "Admission workflow identity changed",
  );
  if (run.status !== "completed") {
    return null;
  }
  requireDispatch(
    run.conclusion === "success",
    "Qualification admission did not succeed; keep the retained request",
  );
  const descriptor = resolveQualificationAdmissionDescriptor({
    repository: REPOSITORY,
    runId: Number(run.id),
    runAttempt: 1,
    workflowRef: admission.workflowRef,
    workflowSha: admission.workflowSha,
  });
  requireDispatch(
    admission.descriptor === null || isDeepStrictEqual(admission.descriptor, descriptor),
    "Retained admission artifact identity changed; never adopt a replacement artifact",
  );
  const authenticated = verifyQualificationAdmission({
    descriptor,
    repository: REPOSITORY,
    candidateSha: record.request.targetSha,
    qualificationSha: record.request.workflowSha,
    workflowRef: record.request.workflowRef,
    inputs: record.request.wireInputs,
  });
  requireDispatch(
    isDeepStrictEqual(authenticated.request, admission.request),
    "Admission returned a different frozen request",
  );
  return { descriptor, run: { id: Number(run.id), attempt: 1 } };
}

export async function qualifyAdmission(
  initialRecord: DispatchRecord,
  retain: (next: DispatchRecord) => void,
  client: QualificationDispatchClient,
) {
  let record = initialRecord;
  const admission = record.admission;
  requireDispatch(admission, "Candidate admission is missing");
  if (admission.phase === "prepared") {
    // P's mutable dispatch selector is checked immediately before the one POST.
    // If it moves in the API window, the observed run SHA refuses adoption.
    const refPath =
      admission.workflowRef === "main" ? "heads/main" : "tags/" + admission.workflowRef;
    const ref: unknown = JSON.parse(client.readApi("repos/" + REPOSITORY + "/git/ref/" + refPath));
    requireDispatch(
      isJsonRecord(ref) &&
        isJsonRecord(ref.object) &&
        ref.object.type === "commit" &&
        ref.object.sha === admission.workflowSha,
      "Admission tooling ref moved before dispatch",
    );
    const directory = mkdtempSync(join(tmpdir(), "openclaw-qualification-request-"));
    const path = join(directory, "dispatch.json");
    try {
      const inputs = {
        operation: "admit-qualification",
        qualification_request: JSON.stringify(admission.request),
      };
      requireDispatch(
        Buffer.byteLength(JSON.stringify(inputs)) <= 65_535,
        "Admission exceeds GitHub workflow input limit",
      );
      writeFileSync(path, JSON.stringify({ ref: admission.workflowRef, inputs }), {
        flag: "wx",
        mode: 0o600,
      });
      record = { ...record, admission: { ...admission, phase: "attempted" } };
      retain(record);
      let response = "";
      try {
        response = client.postApi([
          "api",
          "--include",
          "--method",
          "POST",
          "repos/" + REPOSITORY + "/actions/workflows/" + ADMISSION_WORKFLOW + "/dispatches",
          "--input",
          path,
        ]);
      } catch (error) {
        response = error instanceof Error && "stdout" in error ? stringValue(error.stdout) : "";
      }
      let status = 0;
      try {
        status = client.httpStatus(response);
      } catch {
        /* uncertain response is observation-only */
      }
      if ([400, 401, 403, 404, 422].includes(status)) {
        record = { ...record, admission: { ...admission, phase: "rejected" } };
        retain(record);
        throw new Error("Qualification admission rejected: HTTP " + status);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
  const deadline = Date.now() + 15 * 60_000;
  do {
    const observed = observeQualificationAdmission(record, client);
    if (observed) {
      const envelope = decodePublicationDispatchEnvelope(
        String(record.request.inputs.trusted_workflow_json),
      );
      const packed = JSON.stringify({ ...envelope, qualificationAdmission: observed.descriptor });
      record = {
        ...record,
        admission: { ...admission, ...observed, phase: "observed" },
        request: {
          ...record.request,
          inputs: { ...record.request.inputs, trusted_workflow_json: packed },
          wireInputs: { ...record.request.wireInputs, trusted_workflow_json: packed },
        },
      };
      retain(record);
      return record;
    }
    await sleep(15_000);
  } while (Date.now() < deadline);
  throw new Error(
    "Qualification admission is unconfirmed; reconcile the retained request, never repeat its POST",
  );
}
