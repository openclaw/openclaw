#!/usr/bin/env node
import {
  execFileSync,
  spawnSync,
  type ExecFileSyncOptionsWithBufferEncoding,
  type ExecFileSyncOptionsWithStringEncoding,
} from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { parse as parseYaml } from "yaml";
import { isRecord as isJsonRecord } from "../packages/normalization-core/src/record-coerce.ts";
import {
  decodePublicationDispatchEnvelope,
  normalizePublicationIntent,
  normalizePublicationLaneInputs,
  publicationDispatchEnvelope,
  publicationIntentInputs,
} from "./full-release-publication-contract.mjs";
import {
  classifyReleaseGhTransportError,
  formatReleaseStateOutcome,
  isReleaseGhArtifactMissingError,
  MAX_RELEASE_ARTIFACT_BYTES,
  validateReleaseStateArtifact,
} from "./full-release-validation-policy.mjs";
import { inspectActionsArtifactZipWithPolicy } from "./lib/actions-artifact-archive.mjs";
import { requireOptionArgument } from "./lib/arg-utils.mts";
import {
  REQUEST_KIND,
  CANDIDATE_REQUEST_KIND,
  MAX_REQUEST_BYTES,
  assertRequestPath,
  readDispatchRecord,
  retainDispatchRecord,
  dispatchInputsDigest,
  formatDispatchSelection,
  observeQualificationAdmission,
  qualifyAdmission,
  type DispatchInputs,
  type DispatchRun,
  type DispatchRequest,
  type DispatchRecord,
  type QualificationAdmissionDispatch,
} from "./lib/full-release-dispatch-request.mts";
import { execPlainGh } from "./lib/plain-gh.mjs";
import { parseReleaseContextRef, resolveReleaseContextIdentity } from "./lib/release-context.mjs";
import { resolveQualificationBaselines } from "./lib/release-upgrade-baseline.mjs";
import { validatePackageSourceRef } from "./package-source-preflight.mjs";
import { buildQualificationAdmissionRequest } from "./release-qualification-admission.mjs";

export { dispatchInputsDigest } from "./lib/full-release-dispatch-request.mts";

const REPOSITORY = "openclaw/openclaw";
const WORKFLOW = "full-release-validation.yml";
const TRUSTED_WORKFLOW_PATH = `.github/workflows/${WORKFLOW}`;
const RELEASE_ISOLATION_TOOLING_CONTRACT = "2";
const RELEASE_ISOLATION_TOOLING_CONTRACT_ENV = "RELEASE_ISOLATION_TOOLING_CONTRACT";
const RELEASE_EVIDENCE_VERIFIER_PATHS = [
  "scripts/release-ci-summary.mjs",
  ".agents/skills/release-openclaw-ci/scripts/release-ci-summary.mjs",
];
const GH_READ_TIMEOUT_MS = 60_000;
export const FULL_RELEASE_WAIT_TIMEOUT_MINUTES = 720;
const FULL_RELEASE_GITHUB_POLL_INTERVAL_MS = 2 * 60_000;
const FULL_RELEASE_PROGRESS_INTERVAL_MS = 15 * 60_000;
const FULL_RELEASE_RUN_DISCOVERY_DELAYS_MS = [30_000, 60_000, 120_000];
// A run can wait in the runner queue before its first job uploads the witness.
const FULL_RELEASE_WITNESS_QUEUE_WAIT_MS = 3 * 60 * 60_000;
const ACTIVE_RUN_STATUSES = new Set(["requested", "queued", "pending", "waiting", "in_progress"]);
const RELEASE_DECISION_FILE = "full-release-decision.json";
const GH_NO_CACHE_HEADER = "Cache-Control: max-age=0";
const ADMISSION_WORKFLOW = "openclaw-release-prepare.yml";
const WITNESS_KIND = "openclaw.full-release-dispatch-inputs/v1";
const WITNESS_FILE = "dispatch-inputs.json";
const MAX_WITNESS_ARCHIVE_BYTES = 256 * 1024;
const RUN_PAGE_SIZE = 20;
const MAX_RUN_PAGES = 5;
const GH_READ_OPTIONS = {
  encoding: "utf8",
  killSignal: "SIGKILL",
  stdio: ["ignore", "pipe", "inherit"],
  timeout: GH_READ_TIMEOUT_MS,
} satisfies ExecFileSyncOptionsWithStringEncoding;
const TRUSTED_WORKFLOW_TAG_PATTERN = /^release-publish\/([a-f0-9]{12})-[1-9][0-9]*$/u;
const SHA_PATTERN = /^[a-f0-9]{40}$/u;
const RERUN_GROUPS = new Set([
  "all",
  "ci",
  "plugin-prerelease",
  "install-smoke",
  "cross-os",
  "live-e2e",
  "package",
  "qa-parity",
  "qa-live",
  "npm-telegram",
  "performance",
]);
const DEFAULT_INPUTS = {
  provider: "openai",
  mode: "both",
  rerun_group: "all",
  reuse_evidence: "true",
  fail_fast: "false",
};

type ReleaseInputs = Record<string, string> &
  typeof DEFAULT_INPUTS &
  Partial<Record<"release_profile" | "allow_unreleased_changelog", string>>;
type CommandOptions = {
  dryRun?: boolean;
  stdio?: "inherit" | ["ignore", "pipe" | "ignore", "pipe" | "inherit" | "ignore"];
  timeoutMs?: number;
};
type CommandStatus = {
  error?: Error;
  signal?: unknown;
  status: number | null;
  stderr: unknown;
  stdout: unknown;
};
type TemporaryRefParams = {
  keepBranch: boolean;
  dryRun: boolean;
  parentConclusion: string;
  evidenceVerified: boolean;
};
type TrustedWorkflowHarness = {
  contract: "1" | "2";
  verifierPath: string;
};
function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function displayValue(value: unknown): string {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return value === null ? "null" : (JSON.stringify(value) ?? "<undefined>");
}

function requiredPositiveInteger(value: unknown, label: string): number {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return normalized;
}

function usage() {
  console.error(`Usage: node scripts/full-release-validation-at-sha.mjs [--sha <target-sha>] [--target-ref <canonical-release-branch-or-tag>] [--workflow-sha <candidate-sha>] [--trusted-workflow-ref <candidate|main|release-publish-tag>] [--admission-workflow-sha <P-sha>] [--admission-workflow-ref <main|release-publish-tag>] [--request-file <path>] [--keep-branch] [--dry-run] [-- -f key=value ...]
       node scripts/full-release-validation-at-sha.mjs --reconcile-request <path>
       node scripts/full-release-validation-at-sha.mjs --resume-request <path>

Candidate-owned qualification is the default: C=Q. Invoking it attests that the
selected exact candidate and its qualification policy are reviewed. The existing
prepare workflow at independently trusted P authenticates the complete request;
then this same dispatch owner runs the candidate workflow graph at Q. P defaults
to a pinned main revision, never the qualification harness. Missing C/Q or P
contracts require a deliberate backport/tooling repair; there is no main fallback.
Explicit main/protected qualification tooling retains the historical diagnostic
route. Scheduled main qualification selects that route explicitly.

Retains a private request artifact before remote mutations. An existing --request-file
always performs read-only reconciliation. --reconcile-request refuses a missing file.
--resume-request continues only an admitted candidate request before any Q ref
mutation; after a qualification POST it is observation-only, never a redispatch.
Retain the artifact until operator cleanup; its loss never proves non-execution.
Frozen tooling must declare FULL_RELEASE_DISPATCH_WITNESS_CONTRACT=1 before a new request.
Prints the frozen candidate/tooling, effective profile, group, soak and redacted
waiver selection before dispatch and when reconciling the retained request.

Preflights the Validation SHA with a bare-SHA fetch into a fresh temporary repository.
Creates one immutable release-ci/* workflow ref pinned to the exact Tooling SHA,
dispatches Full Release Validation with the full Validation SHA as its ref input
and expected_sha as its immutable identity,
watches the parent run, independently verifies admitted frozen coverage and exact
child/artifact identities using P, then deletes the temporary
workflow ref by default. --keep-branch retains that ref. Exact-target and changelog-only Release SHA
evidence reuse stay enabled; pass -f reuse_evidence=false to force a fresh
run. Child workflows collect independent failures by default; pass
-f fail_fast=true to cancel only an exact still-active child after Release
Decision identifies a blocking failure for that child. The release
branch accepts its final package version or a matching beta prerelease.
A numeric correction branch also accepts the base package only when its
published base tag resolves to the exact Validation SHA.
The release profile defaults to beta for beta candidates and stable otherwise; pass
-f release_profile=full for the broad advisory sweep. Focused retries must use
one controller rerun_group; the removed release-checks aggregate and the direct
child's manual qa aggregate are not accepted.`);
}

function run(command: string, args: string[], options: CommandOptions = {}) {
  if (options.dryRun) {
    console.log(["+", command, ...args].join(" "));
    return "";
  }
  const output = execFileSync(command, args, {
    encoding: "utf8",
    stdio: options.stdio ?? ["ignore", "pipe", "inherit"],
  });
  return typeof output === "string" ? output.trim() : "";
}

function runStatus(command: string, args: string[], options: CommandOptions = {}): CommandStatus {
  if (options.dryRun) {
    console.log(["+", command, ...args].join(" "));
    return { status: 0, stderr: "", stdout: "" };
  }
  return spawnSync(command, args, {
    encoding: "utf8",
    killSignal: "SIGKILL",
    stdio: options.stdio ?? ["ignore", "pipe", "inherit"],
    timeout: options.timeoutMs ?? GH_READ_TIMEOUT_MS,
  });
}

function runGh(inputArgs: string[], options: CommandOptions = {}) {
  const args =
    inputArgs[0] === "api" && !inputArgs.includes("--hostname")
      ? [...inputArgs, "--hostname", "github.com"]
      : inputArgs;
  if (options.dryRun) {
    console.log(["+", "gh", ...args].join(" "));
    return "";
  }
  const output = execPlainGh(args, {
    encoding: "utf8",
    stdio: options.stdio ?? ["ignore", "pipe", "inherit"],
    ...(options.timeoutMs === undefined ? {} : { timeout: options.timeoutMs }),
  });
  return typeof output === "string" ? (args.includes("--include") ? output : output.trim()) : "";
}

function runGhStatus(args: string[], options: CommandOptions = {}): CommandStatus {
  try {
    return {
      signal: null,
      status: 0,
      stderr: "",
      stdout: execPlainGh(args, {
        encoding: "utf8",
        killSignal: "SIGKILL",
        stdio: options.stdio ?? ["ignore", "pipe", "inherit"],
        timeout: options.timeoutMs ?? GH_READ_TIMEOUT_MS,
      }),
    };
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    const details = failure as Error & {
      signal?: unknown;
      status?: number | null;
      stderr?: unknown;
      stdout?: unknown;
    };
    return {
      error: failure,
      signal: details.signal,
      status: details.status ?? 1,
      stderr: details.stderr ?? "",
      stdout: details.stdout ?? "",
    };
  }
}

function readGhApi(
  endpoint: string,
  fields: string[] = [],
  options: ExecFileSyncOptionsWithStringEncoding = GH_READ_OPTIONS,
) {
  return execPlainGh(
    [
      "api",
      "--method",
      "GET",
      endpoint,
      ...fields,
      "--hostname",
      "github.com",
      "-H",
      GH_NO_CACHE_HEADER,
    ],
    options,
  );
}

function commandFailureMessage(error: unknown): string {
  if (error === undefined || error === null) {
    return "";
  }
  if (!(error instanceof Error)) {
    return displayValue(error);
  }
  const details = error as Error & {
    cause?: unknown;
    stderr?: unknown;
    stdout?: unknown;
  };
  const outputText = (value: unknown) => {
    if (typeof value === "string") {
      return value.trim();
    }
    return Buffer.isBuffer(value) ? value.toString("utf8").trim() : "";
  };
  return [
    outputText(details.stderr),
    outputText(details.stdout),
    error.message,
    details.cause === error ? "" : commandFailureMessage(details.cause),
  ]
    .filter(Boolean)
    .join("\n");
}

function isUnsupportedAllowEscapeSequencesFlag(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const stderr = (error as Error & { stderr?: unknown }).stderr;
  const text =
    typeof stderr === "string" ? stderr : Buffer.isBuffer(stderr) ? stderr.toString("utf8") : "";
  return text
    .replaceAll("\r\n", "\n")
    .split("\n")
    .some((line) => line.trim() === "unknown flag: --allow-escape-sequences");
}

function createTemporaryRef(ref: string, sha: string, dryRun: boolean) {
  try {
    runGh(
      [
        "api",
        "--method",
        "POST",
        `repos/${REPOSITORY}/git/refs`,
        "-f",
        `ref=${ref}`,
        "-f",
        `sha=${sha}`,
      ],
      { dryRun, stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch (error) {
    throw new Error(commandFailureMessage(error), { cause: error });
  }
}

function deleteTemporaryRef(ref: string, dryRun: boolean) {
  try {
    runGh(
      ["api", "--method", "DELETE", `repos/${REPOSITORY}/git/refs/${ref.slice("refs/".length)}`],
      { dryRun },
    );
  } catch (error) {
    throw new Error(`Failed to delete temporary ref ${ref}: ${commandFailureMessage(error)}`, {
      cause: error,
    });
  }
}

export function parseArgs(argv: string[]) {
  const inputs: ReleaseInputs = { ...DEFAULT_INPUTS };
  const args = {
    sha: "",
    targetRef: "",
    trustedWorkflowRef: "candidate",
    workflowSha: "",
    admissionWorkflowRef: "main",
    admissionWorkflowSha: "",
    requestFile: "",
    reconcileRequest: "",
    resumeRequest: "",
    specifiedInputs: [] as string[],
    keepBranch: false,
    dryRun: false,
    inputs,
  };
  const valueOptions = [
    ["--sha", "sha"],
    ["--request-file", "requestFile"],
    ["--reconcile-request", "reconcileRequest"],
    ["--resume-request", "resumeRequest"],
    ["--workflow-sha", "workflowSha"],
    ["--admission-workflow-ref", "admissionWorkflowRef"],
    ["--admission-workflow-sha", "admissionWorkflowSha"],
    ["--trusted-workflow-ref", "trustedWorkflowRef"],
    ["--target-ref", "targetRef"],
  ] as const;
  const assignInput = (assignment: string, errorMessage: string) => {
    const [key, ...valueParts] = assignment.split("=");
    if (!key || valueParts.length === 0) {
      throw new Error(errorMessage);
    }
    args.inputs[key] = valueParts.join("=");
    args.specifiedInputs.push(key);
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--help" || arg === "-h") {
      usage();
      process.exit(0);
    }
    const valueKey = valueOptions.find(([flag]) => flag === arg)?.[1];
    if (valueKey) {
      args[valueKey] = requireOptionArgument(argv, i, arg);
      i += 1;
      continue;
    }
    if (arg === "--keep-branch") {
      args.keepBranch = true;
      continue;
    }
    if (arg === "--dry-run") {
      args.dryRun = true;
      continue;
    }
    if (arg === "--") {
      const extras = argv.slice(i + 1);
      for (let extraIndex = 0; extraIndex < extras.length; extraIndex += 1) {
        const extra = extras[extraIndex]!;
        let assignment;
        if (extra === "-f") {
          assignment = requireOptionArgument(extras, extraIndex, extra);
          extraIndex += 1;
        } else {
          assignment = extra.startsWith("-f") ? extra.slice(2).trim() : extra;
        }
        assignInput(assignment, `Unsupported extra argument after --: ${extra}`);
      }
      break;
    }
    if (arg === "-f") {
      const assignment = requireOptionArgument(argv, i, arg);
      i += 1;
      assignInput(assignment, `Invalid -f assignment: ${assignment}`);
      continue;
    }
    if (arg.startsWith("-f") && arg.includes("=")) {
      const assignment = arg.slice(2).trim();
      assignInput(assignment, `Invalid -f assignment: ${arg}`);
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (args.reconcileRequest || args.resumeRequest) {
    if (argv.length !== 2 || !["--reconcile-request", "--resume-request"].includes(argv[0] ?? "")) {
      throw new Error("Request recovery accepts only the retained request path");
    }
    return args;
  }
  if (!["true", "false"].includes(args.inputs.reuse_evidence)) {
    throw new Error("reuse_evidence must be true or false");
  }
  if (!["true", "false"].includes(args.inputs.fail_fast)) {
    throw new Error("fail_fast must be true or false");
  }
  if (
    Object.hasOwn(args.inputs, "allow_unreleased_changelog") &&
    !["true", "false"].includes(args.inputs.allow_unreleased_changelog ?? "")
  ) {
    throw new Error("allow_unreleased_changelog must be true or false");
  }
  if (
    args.inputs.release_profile &&
    !["beta", "stable", "full"].includes(args.inputs.release_profile)
  ) {
    throw new Error("release_profile must be beta, stable, or full");
  }
  if (!RERUN_GROUPS.has(args.inputs.rerun_group)) {
    throw new Error(`rerun_group must be one of: ${[...RERUN_GROUPS].join(", ")}`);
  }
  if (Object.hasOwn(args.inputs, "ref")) {
    throw new Error("SHA-pinned release validation reserves the ref input for --sha");
  }
  if (Object.hasOwn(args.inputs, "expected_sha")) {
    throw new Error("SHA-pinned release validation reserves expected_sha for the resolved --sha");
  }
  if (Object.hasOwn(args.inputs, "qualification_baselines_json")) {
    throw new Error(
      "SHA-pinned qualification resolves its candidate-owned baselines before admission; qualification_baselines_json is reserved",
    );
  }
  if (Object.hasOwn(args.inputs, "trusted_workflow_json")) {
    throw new Error("SHA-pinned release validation reserves trusted_workflow_json");
  }
  if (
    args.targetRef.includes("-alpha.") ||
    args.targetRef.includes("tideclaw/alpha/") ||
    args.trustedWorkflowRef.includes("tideclaw/alpha/")
  ) {
    throw new Error("Alpha releases are retired; use a beta prerelease instead.");
  }
  const targetContext = parseReleaseContextRef(args.targetRef);
  if (args.targetRef && !targetContext) {
    throw new Error("--target-ref must be a canonical OpenClaw release branch or tag");
  }
  args.targetRef = targetContext?.ref ?? args.targetRef;
  if (
    args.trustedWorkflowRef !== "candidate" &&
    args.trustedWorkflowRef !== "main" &&
    !TRUSTED_WORKFLOW_TAG_PATTERN.test(args.trustedWorkflowRef)
  ) {
    throw new Error(
      "--trusted-workflow-ref must be candidate, main, or a protected release-publish/<12hex>-<decimal> tag",
    );
  }
  if (args.workflowSha && !SHA_PATTERN.test(args.workflowSha)) {
    throw new Error("--workflow-sha requires an explicit full Tooling SHA");
  }
  if (
    !["candidate", "main"].includes(args.trustedWorkflowRef) &&
    !SHA_PATTERN.test(args.workflowSha.toLowerCase())
  ) {
    throw new Error(
      "protected release-publish workflow refs require --workflow-sha with an explicit full Tooling SHA",
    );
  }
  if (
    args.trustedWorkflowRef !== "candidate" &&
    targetContext &&
    targetContext.kind !== "release tag" &&
    !SHA_PATTERN.test(args.workflowSha.toLowerCase())
  ) {
    throw new Error(
      "release-branch validation requires --workflow-sha with an explicit full Tooling SHA",
    );
  }
  if (
    args.admissionWorkflowRef !== "main" &&
    !TRUSTED_WORKFLOW_TAG_PATTERN.test(args.admissionWorkflowRef)
  ) {
    throw new Error("Admission tooling must use main or an exact protected publication tag");
  }
  if (args.admissionWorkflowRef !== "main" && !SHA_PATTERN.test(args.admissionWorkflowSha)) {
    throw new Error("Protected admission tooling requires its full --admission-workflow-sha");
  }
  return args;
}

export function resolveRemoteTargetRefSha(
  targetRef: string,
  executeGit: (args: string[]) => string = (args) => run("git", args),
) {
  const context = parseReleaseContextRef(targetRef);
  if (!context) {
    throw new Error("Target ref must be a canonical OpenClaw release branch or tag");
  }
  if (context.kind !== "release tag") {
    return (
      executeGit(["ls-remote", "--heads", "origin", `refs/heads/${context.ref}`]).split(
        /\s+/u,
      )[0] ?? ""
    );
  }

  const tagRef = `refs/tags/${context.ref}`;
  const peeledSha = executeGit(["ls-remote", "--tags", "origin", `${tagRef}^{}`]).split(/\s+/u)[0];
  if (peeledSha) {
    return peeledSha;
  }
  return executeGit(["ls-remote", "--tags", "origin", tagRef]).split(/\s+/u)[0] ?? "";
}

export function verifyTargetRef(
  targetRef: string,
  targetSha: string,
  targetVersion: string,
  resolveRemoteSha: (ref: string) => string = resolveRemoteTargetRefSha,
  isAncestor: (ancestor: string, descendant: string) => boolean = (ancestor, descendant) =>
    runStatus("git", ["merge-base", "--is-ancestor", ancestor, descendant], {
      stdio: ["ignore", "ignore", "ignore"],
    }).status === 0,
) {
  if (!targetRef) {
    return targetSha;
  }
  const identity = resolveReleaseContextIdentity(targetRef, targetVersion);
  if (!identity) {
    throw new Error("Target ref must be a canonical OpenClaw release branch or tag");
  }
  const remoteSha = resolveRemoteSha(targetRef);
  if (!remoteSha) {
    throw new Error(`Target ref ${targetRef} does not resolve to a commit`);
  }
  if (identity.kind !== "release tag") {
    if (!isAncestor(targetSha, remoteSha)) {
      throw new Error(
        `Target SHA ${targetSha} is not reachable from release branch ${targetRef} at ${remoteSha}`,
      );
    }
  } else if (remoteSha.toLowerCase() !== targetSha.toLowerCase()) {
    throw new Error(`Target ref ${targetRef} does not resolve to ${targetSha}`);
  }
  if (identity.baseTag) {
    const baseSha = resolveRemoteSha(identity.baseTag);
    if (baseSha.toLowerCase() !== targetSha.toLowerCase()) {
      throw new Error(
        `Fallback correction ${identity.releaseTag} must use the same source commit as ${identity.baseTag}; expected ${targetSha}, found ${baseSha || "missing"}.`,
      );
    }
  }
  return targetRef;
}

function resolveSha(requestedSha: string) {
  const rev = requestedSha || "HEAD";
  return run("git", ["rev-parse", "--verify", `${rev}^{commit}`], { dryRun: false });
}

function fetchTargetRef(targetRef: string) {
  if (!targetRef) {
    return;
  }
  const context = parseReleaseContextRef(targetRef);
  if (!context) {
    throw new Error("Target ref must be a canonical OpenClaw release branch or tag");
  }
  const sourceRef = `refs/${context.kind === "release tag" ? "tags" : "heads"}/${context.ref}`;
  run("git", ["fetch", "--no-tags", "origin", sourceRef], {
    stdio: "inherit",
  });
}

function resolveTargetSha(requestedSha: string, targetRef: string) {
  fetchTargetRef(targetRef);
  const revision = requestedSha || "HEAD";
  const resolved = runStatus("git", ["rev-parse", "--verify", `${revision}^{commit}`], {
    stdio: ["ignore", "pipe", "ignore"],
  });
  const resolvedSha = typeof resolved.stdout === "string" ? resolved.stdout.trim() : "";
  if (resolved.status !== 0 || !resolvedSha) {
    throw new Error(
      targetRef
        ? `Target SHA ${revision} is not available locally after fetching ${targetRef}`
        : `Target SHA ${revision} is not available locally; pass --target-ref so it can be fetched by name`,
    );
  }
  return resolvedSha;
}

function preflightTargetShaFetch(targetSha: string) {
  const directory = mkdtempSync(join(tmpdir(), "openclaw-release-fetch-"));
  try {
    run("git", ["-C", directory, "init", "-q"]);
    const result = runStatus(
      "git",
      [
        "-C",
        directory,
        "fetch",
        "--no-tags",
        "--depth=1",
        "--filter=blob:none",
        `https://github.com/${REPOSITORY}.git`,
        targetSha,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    if (result.status !== 0) {
      throw new Error(
        `GitHub refused to serve Validation SHA ${targetSha} by bare SHA; child checkouts fetch it the same way, so dispatch would fail. Push it to a GitHub branch first. ${stringValue(result.stderr).trim().slice(-2000) || result.error?.message || "git fetch failed"}`,
      );
    }
    console.log(`Validation SHA fetchable by bare SHA: ${targetSha}`);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

function targetVersionForTarget(targetSha: string): string {
  let version: unknown;
  try {
    version = JSON.parse(run("git", ["show", `${targetSha}:package.json`])).version;
  } catch {
    throw new Error(`Could not read package.json from target SHA ${targetSha}`);
  }
  if (typeof version !== "string" || !/^[0-9]{4}\.[0-9]+\.[0-9]+(?:-.+)?$/u.test(version)) {
    throw new Error(`Target SHA ${targetSha} has an invalid package version`);
  }
  return version;
}

export function releaseProfileForVersion(version: string): "beta" | "stable" {
  if (version.includes("-alpha.")) {
    throw new Error("Alpha releases are retired; use a beta prerelease instead.");
  }
  return /-beta\.[1-9][0-9]*$/u.test(version) ? "beta" : "stable";
}

export function verifyTrustedWorkflowRef(
  workflowSha: string,
  trustedWorkflowRef: string,
  resolveRemoteTagSha: (tag: string) => string = (tag) =>
    run("git", ["ls-remote", "--tags", "origin", `refs/tags/${tag}`]).split(/\s+/u)[0] ?? "",
  isMainAncestor: (sha: string) => boolean = (sha) =>
    runStatus("git", ["merge-base", "--is-ancestor", sha, "refs/remotes/origin/main"]).status === 0,
) {
  if (trustedWorkflowRef === "main") {
    if (!isMainAncestor(workflowSha)) {
      throw new Error(
        `Workflow SHA ${workflowSha} is not reachable from current origin/main; refusing an untrusted release harness.`,
      );
    }
    return;
  }

  const tagMatch = trustedWorkflowRef.match(TRUSTED_WORKFLOW_TAG_PATTERN);
  if (!tagMatch) {
    throw new Error(
      "trusted workflow ref must be main or a protected release-publish/<12hex>-<decimal> tag",
    );
  }
  if (workflowSha.slice(0, 12) !== tagMatch[1]) {
    throw new Error(
      `Trusted workflow tag ${trustedWorkflowRef} does not match Tooling SHA ${workflowSha}`,
    );
  }
  const remoteTagSha = resolveRemoteTagSha(trustedWorkflowRef);
  if (!remoteTagSha) {
    throw new Error(`Trusted workflow tag ${trustedWorkflowRef} does not exist on origin`);
  }
  if (remoteTagSha.toLowerCase() !== workflowSha.toLowerCase()) {
    throw new Error(
      `Trusted workflow tag ${trustedWorkflowRef} resolves to ${remoteTagSha}, expected ${workflowSha}`,
    );
  }
}

function resolveTrustedWorkflowSha(requestedSha: string, trustedWorkflowRef: string) {
  if (trustedWorkflowRef === "main") {
    run("git", ["fetch", "--no-tags", "origin", "refs/heads/main:refs/remotes/origin/main"], {
      stdio: "inherit",
    });
  }
  const workflowSha = resolveSha(requestedSha || "origin/main");
  verifyTrustedWorkflowRef(workflowSha, trustedWorkflowRef);
  return workflowSha;
}

function assertAdmissionContract(admissionWorkflowSha: string) {
  const workflow = parseYaml(
    run("git", ["show", `${admissionWorkflowSha}:.github/workflows/${ADMISSION_WORKFLOW}`]),
  );
  requireDispatch(
    workflow?.env?.RELEASE_QUALIFICATION_ADMISSION_CONTRACT === "1",
    "Selected P lacks qualification admission; update P independently without changing C/Q",
  );
}

// Main routinely advances between P selection and the admission POST. A newer
// tip replaces P only when it is trusted main, descends from the selected P,
// and still declares the admission contract.
function verifyMainAdmissionAdvance(previousSha: string, currentSha: string) {
  requireDispatch(
    resolveTrustedWorkflowSha(currentSha, "main") === currentSha,
    `Main tip ${currentSha} did not resolve to itself`,
  );
  requireDispatch(
    runStatus("git", ["merge-base", "--is-ancestor", previousSha, currentSha]).status === 0,
    `Main tip ${currentSha} does not descend from selected P ${previousSha}`,
  );
  assertAdmissionContract(currentSha);
}

function requireDispatch(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function resolveDispatchSelection(workflowSha: string, overrides: Record<string, string>) {
  const workflow: unknown = parseYaml(
    run("git", ["show", `${workflowSha}:${TRUSTED_WORKFLOW_PATH}`]),
  );
  requireDispatch(
    isJsonRecord(workflow) &&
      isJsonRecord(workflow.env) &&
      workflow.env.FULL_RELEASE_DISPATCH_WITNESS_CONTRACT === "1",
    `Tooling SHA ${workflowSha} does not support FULL_RELEASE_DISPATCH_WITNESS_CONTRACT=1; no remote refs or run were created. Keep the frozen Tooling SHA. Existing runs use frv status; a new request needs separately approved witness-capable tooling.`,
  );
  requireDispatch(
    workflow.env.FULL_RELEASE_SOURCE_ADMISSION_CONTRACT === "1",
    `Tooling SHA ${workflowSha} does not support source admission; no remote refs or run were created. Keep the frozen tooling SHA. Reopen existing requests read-only; new tooling requires separate approval.`,
  );
  requireDispatch(
    isJsonRecord(workflow.on) &&
      isJsonRecord(workflow.on.workflow_dispatch) &&
      isJsonRecord(workflow.on.workflow_dispatch.inputs),
    "Pinned workflow input schema is invalid",
  );
  const definitions = workflow.on.workflow_dispatch.inputs;
  requireDispatch(
    Object.keys(definitions).length <= 25,
    "Pinned workflow exceeds 25 dispatch inputs",
  );
  const {
    validation_purpose,
    publication_selection_json,
    extension_test_exclude_patterns_json,
    qualification_baselines_json,
    known_flaky_jobs_json,
    ...wireOverrides
  } = overrides;
  const laneInputs =
    extension_test_exclude_patterns_json === undefined && qualification_baselines_json === undefined
      ? undefined
      : {
          ...(extension_test_exclude_patterns_json === undefined
            ? {}
            : { extension_test_exclude_patterns_json }),
          ...(qualification_baselines_json === undefined ? {} : { qualification_baselines_json }),
        };
  requireDispatch(
    laneInputs === undefined || workflow.env.FULL_RELEASE_LANE_INPUTS_CONTRACT === "1",
    `Tooling SHA ${workflowSha} does not support packed lane inputs; no remote refs or run were created. Keep the frozen Tooling SHA.`,
  );
  requireDispatch(
    known_flaky_jobs_json === undefined,
    "Automatic test retries are disabled; remove known_flaky_jobs_json and diagnose the failed job.",
  );
  const intent = normalizePublicationIntent(validation_purpose, publication_selection_json);
  requireDispatch(
    intent.validationPurpose !== "publish" ||
      workflow.env.FULL_RELEASE_PUBLICATION_ADMISSION_CONTRACT === "1",
    `Tooling SHA ${workflowSha} does not support registry admission for fresh publish requests; no remote refs or run were created. Keep the frozen tooling SHA. Reopen existing requests read-only; new tooling requires separate approval.`,
  );
  wireOverrides.trusted_workflow_json = publicationDispatchEnvelope(
    JSON.parse(overrides.trusted_workflow_json || "null"),
    intent,
    laneInputs,
  );
  requireDispatch(
    Object.keys(wireOverrides).every((key) => Object.hasOwn(definitions, key)),
    "Undeclared workflow input",
  );
  const inputs: DispatchInputs = {};
  const wireInputs: Record<string, string> = {};
  for (const [key, definition] of Object.entries(definitions)) {
    requireDispatch(
      /^[a-z][a-z0-9_]*$/u.test(key) && isJsonRecord(definition),
      "Invalid workflow input definition",
    );
    const raw: unknown =
      wireOverrides[key] ?? definition.default ?? (definition.type === "boolean" ? false : "");
    const text = String(raw);
    let value: string | number | boolean = text;
    if (definition.type === "boolean") {
      requireDispatch(["true", "false"].includes(text), `Input ${key} must be true or false`);
      value = text === "true";
    } else if (definition.type === "number") {
      requireDispatch(
        text.trim() !== "" && Number.isFinite(Number(text)),
        `Input ${key} must be a number`,
      );
      value = Number(text);
    } else {
      requireDispatch(
        ["string", "choice", "environment"].includes(stringValue(definition.type)),
        `Unsupported input type for ${key}`,
      );
      if (definition.type === "choice") {
        requireDispatch(
          Array.isArray(definition.options) && definition.options.includes(text),
          `Invalid choice for ${key}`,
        );
      }
    }
    inputs[key] = value;
    wireInputs[key] = String(value);
  }
  decodePublicationDispatchEnvelope(inputs.trusted_workflow_json);
  return {
    inputs,
    wireInputs,
    effectiveSoak:
      inputs.run_release_soak === true ||
      inputs.release_profile === "stable" ||
      inputs.release_profile === "full",
  };
}

function parseGhHttpResponse(output: string) {
  const match = /^HTTP\/[\d.]+ (\d{3})[^\r\n]*\r?\n([\s\S]*?)\r?\n\r?\n([\s\S]*)$/u.exec(output);
  requireDispatch(match, "GitHub response did not include complete HTTP headers");
  const headers = new Headers();
  for (const line of match[2]!.split(/\r?\n/u)) {
    if (!line) {
      continue;
    }
    const separator = line.indexOf(":");
    requireDispatch(separator > 0, "GitHub response contains malformed headers");
    headers.append(line.slice(0, separator), line.slice(separator + 1).trim());
  }
  return { status: Number(match[1]), headers, body: match[3]! };
}

function readDispatchRuns(request: DispatchRequest) {
  const runs: Record<string, unknown>[] = [];
  let total: number | undefined;
  for (let page = 1; page <= MAX_RUN_PAGES; page += 1) {
    const response = parseGhHttpResponse(
      readGhApi(`repos/${REPOSITORY}/actions/workflows/${request.workflowId}/runs`, [
        "--include",
        "-f",
        `branch=${request.workflowRef}`,
        "-f",
        "event=workflow_dispatch",
        "-f",
        `per_page=${RUN_PAGE_SIZE}`,
        "-f",
        `page=${page}`,
      ]),
    );
    requireDispatch(
      response.status === 200,
      "Dispatch run inventory returned a non-success response",
    );
    const value: unknown = JSON.parse(response.body);
    requireDispatch(
      isJsonRecord(value) &&
        Array.isArray(value.workflow_runs) &&
        Number.isSafeInteger(value.total_count) &&
        Number(value.total_count) >= 0 &&
        Number(value.total_count) <= RUN_PAGE_SIZE * MAX_RUN_PAGES,
      "Dispatch run inventory is incomplete or exceeds its bound",
    );
    total ??= Number(value.total_count);
    requireDispatch(
      value.total_count === total &&
        value.workflow_runs.length === Math.min(RUN_PAGE_SIZE, total - runs.length),
      "Dispatch run pagination changed or is incomplete",
    );
    for (const item of value.workflow_runs) {
      requireDispatch(
        isJsonRecord(item) &&
          Number.isSafeInteger(item.id) &&
          Number(item.id) > 0 &&
          !runs.some((other) => other.id === item.id),
        "Dispatch run inventory contains invalid or repeated IDs",
      );
      runs.push(item);
    }
    const next = response.headers.get("link")?.match(/<([^>]+)>;\s*rel="next"/u)?.[1];
    if (runs.length === total) {
      requireDispatch(!next, "Dispatch run pagination is uncertain");
      return runs;
    }
    requireDispatch(next, "Dispatch run inventory omitted its next page");
    const url = new URL(next);
    requireDispatch(
      url.origin === "https://api.github.com" &&
        url.pathname === `/repos/${REPOSITORY}/actions/workflows/${request.workflowId}/runs` &&
        url.searchParams.get("page") === String(page + 1) &&
        url.searchParams.get("branch") === request.workflowRef &&
        url.searchParams.get("event") === "workflow_dispatch" &&
        url.searchParams.get("per_page") === String(RUN_PAGE_SIZE),
      "Dispatch run pagination changed scope",
    );
  }
  throw new Error("Dispatch run inventory exceeded its page bound");
}

function assertDispatchRun(workflowRun: unknown, request: DispatchRequest, expected: DispatchRun) {
  requireDispatch(
    isJsonRecord(workflowRun) &&
      workflowRun.id === expected.id &&
      workflowRun.run_attempt === expected.attempt &&
      workflowRun.workflow_id === request.workflowId &&
      workflowRun.head_sha === request.workflowSha &&
      workflowRun.head_branch === request.workflowRef &&
      workflowRun.event === request.event &&
      [
        request.workflowPath,
        `${request.workflowPath}@${request.workflowRef}`,
        `${request.workflowPath}@refs/heads/${request.workflowRef}`,
      ].includes(stringValue(workflowRun.path)) &&
      isJsonRecord(workflowRun.repository) &&
      workflowRun.repository.full_name === request.repository &&
      isJsonRecord(workflowRun.head_repository) &&
      workflowRun.head_repository.full_name === request.repository &&
      workflowRun.display_title === "Full Release Validation" &&
      workflowRun.html_url === `https://github.com/${REPOSITORY}/actions/runs/${expected.id}`,
    "Dispatch run does not match the exact retained workflow/ref/event/attempt identity",
  );
}

async function readDispatchWitness(request: DispatchRequest, observed: DispatchRun) {
  const name = `full-release-dispatch-inputs-${observed.id}-${observed.attempt}`;
  const inventory: unknown = JSON.parse(
    readGhApi(
      `repos/${REPOSITORY}/actions/runs/${observed.id}/artifacts`,
      ["-f", `name=${name}`, "-f", "per_page=100"],
      { ...GH_READ_OPTIONS, maxBuffer: MAX_REQUEST_BYTES },
    ),
  );
  requireDispatch(
    isJsonRecord(inventory) &&
      Array.isArray(inventory.artifacts) &&
      Number.isSafeInteger(inventory.total_count) &&
      inventory.total_count === inventory.artifacts.length &&
      inventory.total_count <= 100,
    "Dispatch witness inventory is incomplete",
  );
  if (inventory.artifacts.length === 0) {
    return false;
  }
  requireDispatch(inventory.artifacts.length === 1, "Dispatch witness is ambiguous");
  const metadata: unknown = inventory.artifacts[0];
  requireDispatch(
    isJsonRecord(metadata) &&
      typeof metadata.id === "number" &&
      Number.isSafeInteger(metadata.id) &&
      metadata.id > 0 &&
      metadata.name === name &&
      typeof metadata.size_in_bytes === "number" &&
      Number.isSafeInteger(metadata.size_in_bytes) &&
      metadata.size_in_bytes > 0 &&
      metadata.size_in_bytes <= MAX_WITNESS_ARCHIVE_BYTES &&
      typeof metadata.digest === "string" &&
      /^sha256:[a-f0-9]{64}$/u.test(metadata.digest) &&
      metadata.expired === false &&
      typeof metadata.expires_at === "string" &&
      Date.parse(metadata.expires_at) > Date.now() &&
      isJsonRecord(metadata.workflow_run) &&
      metadata.workflow_run.id === observed.id &&
      metadata.workflow_run.head_sha === request.workflowSha,
    "Dispatch witness metadata does not match its exact run",
  );
  const artifactEndpoint = `repos/${REPOSITORY}/actions/artifacts/${metadata.id}`;
  const exactMetadata: unknown = JSON.parse(
    readGhApi(artifactEndpoint, [], { ...GH_READ_OPTIONS, maxBuffer: MAX_REQUEST_BYTES }),
  );
  requireDispatch(
    isJsonRecord(exactMetadata) &&
      exactMetadata.id === metadata.id &&
      exactMetadata.name === name &&
      exactMetadata.size_in_bytes === metadata.size_in_bytes &&
      exactMetadata.digest === metadata.digest &&
      exactMetadata.expired === false &&
      exactMetadata.expires_at === metadata.expires_at &&
      Date.parse(metadata.expires_at) > Date.now() &&
      isJsonRecord(exactMetadata.workflow_run) &&
      exactMetadata.workflow_run.id === observed.id &&
      exactMetadata.workflow_run.head_sha === request.workflowSha,
    "Dispatch witness metadata changed from its exact artifact tuple",
  );
  // Keep credentials and redirects owned by the selected CLI; ZIP bytes must not be decoded.
  const archiveArgs = [
    "api",
    "--method",
    "GET",
    `${artifactEndpoint}/zip`,
    "--hostname",
    "github.com",
    "-H",
    GH_NO_CACHE_HEADER,
  ];
  const archiveOptions = {
    ...GH_READ_OPTIONS,
    encoding: null,
    maxBuffer: MAX_WITNESS_ARCHIVE_BYTES,
    stdio: ["ignore", "pipe", "pipe"],
  } satisfies ExecFileSyncOptionsWithBufferEncoding;
  let archiveBytes: Uint8Array<ArrayBuffer>;
  try {
    archiveBytes = execPlainGh([...archiveArgs, "--allow-escape-sequences"], archiveOptions);
  } catch (error) {
    if (!isUnsupportedAllowEscapeSequencesFlag(error)) {
      throw error;
    }
    archiveBytes = execPlainGh(archiveArgs, archiveOptions);
  }
  requireDispatch(
    archiveBytes.byteLength === metadata.size_in_bytes &&
      `sha256:${createHash("sha256").update(archiveBytes).digest("hex")}` === metadata.digest,
    "Dispatch witness archive does not match its exact size and digest",
  );
  const files = inspectActionsArtifactZipWithPolicy(archiveBytes, {
    expectedEntries: [WITNESS_FILE],
    maxArchiveBytes: MAX_WITNESS_ARCHIVE_BYTES,
    maxCompressedEntryBytes: () => MAX_WITNESS_ARCHIVE_BYTES,
    maxEntryBytes: () => MAX_REQUEST_BYTES,
    maxExpandedBytes: MAX_REQUEST_BYTES,
  });
  const witness: unknown = JSON.parse(files.get(WITNESS_FILE).toString("utf8"));
  requireDispatch(
    isDeepStrictEqual(witness, {
      kind: WITNESS_KIND,
      serverUrl: "https://github.com",
      repository: REPOSITORY,
      workflowRef: `${REPOSITORY}/${request.workflowPath}@refs/heads/${request.workflowRef}`,
      event: request.event,
      ref: `refs/heads/${request.workflowRef}`,
      sha: request.workflowSha,
      runId: String(observed.id),
      runAttempt: String(observed.attempt),
      inputsDigest: dispatchInputsDigest(request.wireInputs),
    }),
    "Dispatch input witness does not match the complete retained request",
  );
  return true;
}

async function reconcileDispatch(record: DispatchRecord): Promise<DispatchRun> {
  requireDispatch(
    record.phase !== "prepared",
    "No attempted workflow POST was retained; dispatch remains unknown",
  );
  requireDispatch(
    record.phase !== "rejected",
    "dispatch=rejected: GitHub rejected the retained request",
  );
  const request = record.request;
  const witnessDeadline = Date.now() + FULL_RELEASE_WITNESS_QUEUE_WAIT_MS;
  for (let attempt = 0; ; attempt += 1) {
    const runs = readDispatchRuns(request);
    let queuedRun = "";
    if (runs.length > 0) {
      requireDispatch(
        runs.length === 1,
        "Multiple dispatch runs exist for the retained transport; adoption is ambiguous",
      );
      const observed = record.run ?? { id: Number(runs[0]!.id), attempt: 1 };
      assertDispatchRun(runs[0], request, observed);
      const current: unknown = JSON.parse(
        readGhApi(`repos/${REPOSITORY}/actions/runs/${observed.id}`),
      );
      assertDispatchRun(current, request, observed);
      if (isJsonRecord(current) && ACTIVE_RUN_STATUSES.has(stringValue(current.status))) {
        queuedRun = `${observed.id} (${stringValue(current.status)})`;
      }
      if (await readDispatchWitness(request, observed)) {
        // Recheck both identity and inventory after the archive read, which can span a rerun.
        assertDispatchRun(
          JSON.parse(readGhApi(`repos/${REPOSITORY}/actions/runs/${observed.id}`)),
          request,
          observed,
        );
        const after = readDispatchRuns(request);
        requireDispatch(after.length === 1, "Dispatch run inventory changed during reconciliation");
        assertDispatchRun(after[0], request, observed);
        return observed;
      }
    }
    let delay = FULL_RELEASE_RUN_DISCOVERY_DELAYS_MS[attempt];
    if (delay === undefined && queuedRun && Date.now() < witnessDeadline) {
      // The exact run exists but has not reached the job that uploads its input witness.
      console.warn(`dispatch=pending-witness: run ${queuedRun} has not uploaded its witness yet`);
      delay = Math.min(FULL_RELEASE_GITHUB_POLL_INTERVAL_MS, witnessDeadline - Date.now());
    }
    if (delay === undefined) {
      break;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
  }
  throw new Error("Could not determine Full Release Validation run id: discovery exhausted");
}

const qualificationDispatchClient = {
  readApi: readGhApi,
  postApi: (args: string[]) => runGh(args, { stdio: ["ignore", "pipe", "pipe"] }),
  httpStatus: (response: string) => parseGhHttpResponse(response).status,
  verifyMainAdvance: verifyMainAdmissionAdvance,
};

async function reopenDispatch(path: string, args: ReturnType<typeof parseArgs>, argv: string[]) {
  const record = readDispatchRecord(path);
  const request = record.request;
  let retainedInputs = request.wireInputs;
  let retainedIntent: ReturnType<typeof publicationIntentInputs> | undefined;
  const rawIdentity = request.wireInputs.trusted_workflow_json;
  if (rawIdentity && Object.hasOwn(JSON.parse(rawIdentity), "trustedWorkflow")) {
    const envelope = decodePublicationDispatchEnvelope(rawIdentity);
    retainedIntent = publicationIntentInputs(envelope);
    retainedInputs = {
      ...retainedInputs,
      ...envelope.laneInputs,
      validation_purpose: retainedIntent.validationPurpose,
      publication_selection_json: retainedIntent.publicationSelectionJson,
    };
  }
  requireDispatch(
    (!args.sha || args.sha === request.targetSha) &&
      (!args.workflowSha || args.workflowSha === request.workflowSha) &&
      (!args.targetRef || args.targetRef === request.targetContextRef) &&
      (!argv.includes("--trusted-workflow-ref") ||
        args.trustedWorkflowRef === request.trustedWorkflowRef) &&
      args.specifiedInputs.every((key) =>
        key === "publication_selection_json" && retainedIntent
          ? publicationIntentInputs(
              normalizePublicationIntent(retainedIntent.validationPurpose, args.inputs[key]),
            ).publicationSelectionJson === retainedIntent.publicationSelectionJson
          : key === "extension_test_exclude_patterns_json"
            ? normalizePublicationLaneInputs({ [key]: args.inputs[key] })[key] ===
              retainedInputs[key]
            : args.inputs[key] === retainedInputs[key],
      ),
    "Reopen arguments conflict with the retained request",
  );
  console.log(formatDispatchSelection(request));
  try {
    if (record.admission && record.phase === "prepared") {
      const observed = observeQualificationAdmission(record, qualificationDispatchClient);
      requireDispatch(
        observed,
        "Admission remains unconfirmed; no qualification workflow was dispatched",
      );
      console.log(
        `admission=observed: https://github.com/${REPOSITORY}/actions/runs/${observed.run.id}`,
      );
      console.log(
        `Qualification has not dispatched. Continue the same retained request with --resume-request ${JSON.stringify(path)}`,
      );
      return;
    }
    const observed = await reconcileDispatch(record);
    console.log(
      `dispatch=observed: https://github.com/${REPOSITORY}/actions/runs/${observed.id} attempt=${observed.attempt}`,
    );
  } catch (error) {
    console.error(
      `dispatch=${record.phase === "rejected" ? "rejected" : "unknown"} error=${record.error}`,
    );
    console.error(`Retained workflow ref: refs/heads/${request.workflowRef}`);
    throw error;
  }
}

function readWorkflowRun(parentRunId: string, workflowSha: string) {
  if (!/^[1-9][0-9]*$/u.test(parentRunId)) {
    throw new Error("parent run ID must be a positive decimal");
  }
  const workflowRun: unknown = JSON.parse(
    readGhApi(`repos/${REPOSITORY}/actions/runs/${parentRunId}`, [], GH_READ_OPTIONS),
  );
  if (!isJsonRecord(workflowRun)) {
    throw new Error(`Full Release Validation run ${parentRunId} returned an invalid response`);
  }
  if (workflowRun.head_sha !== workflowSha) {
    throw new Error(
      `Full Release Validation run ${parentRunId} head ${displayValue(workflowRun.head_sha)} does not match trusted workflow SHA ${workflowSha}`,
    );
  }
  return workflowRun;
}

function readActiveParentJobs(parentRunId: string) {
  const response: unknown = JSON.parse(
    readGhApi(
      `repos/${REPOSITORY}/actions/runs/${parentRunId}/jobs`,
      ["-f", "per_page=100"],
      GH_READ_OPTIONS,
    ),
  );
  if (!isJsonRecord(response) || !Array.isArray(response.jobs)) {
    throw new Error(`Full Release Validation run ${parentRunId} returned invalid jobs`);
  }
  return response.jobs
    .filter((job) => isJsonRecord(job) && job.status !== "completed")
    .map((job) => ({
      name: isJsonRecord(job) ? stringValue(job.name, "<unnamed>") : "<unnamed>",
      status: isJsonRecord(job) ? stringValue(job.status, "pending") : "pending",
      url: isJsonRecord(job) ? stringValue(job.html_url) : "",
    }));
}

export function validateReleaseDecisionPayload(
  payload: unknown,
  expected: {
    parentRunAttempt: number;
    parentRunId: string;
    workflowSha: string;
  },
) {
  return validateReleaseStateArtifact(payload, expected, "decision");
}

export function releaseDecisionStopsForeground(state: unknown) {
  return [
    "blocked_diagnostics_running",
    "blocked_complete",
    "orchestration_error",
    "cancelled_with_children",
  ].includes(stringValue(state));
}

function readReleaseDecisionArtifact(
  parentRunId: string,
  artifactName: string,
  entryName: string,
  runStatusImpl: (command: string, args: string[], options?: CommandOptions) => CommandStatus = (
    _command,
    args,
    options,
  ) => runGhStatus(args, options),
) {
  const downloadDir = mkdtempSync(join(tmpdir(), "openclaw-release-decision-"));
  try {
    const result = runStatusImpl(
      "gh",
      [
        "run",
        "download",
        parentRunId,
        "--repo",
        REPOSITORY,
        "--name",
        artifactName,
        "--dir",
        downloadDir,
      ],
      { stdio: ["ignore", "ignore", "pipe"], timeoutMs: GH_READ_TIMEOUT_MS },
    );
    if (result.status !== 0) {
      const stderr = stringValue(result.stderr);
      if (isReleaseGhArtifactMissingError({ cause: result.error, stderr })) {
        return undefined;
      }
      const downloadError = Object.assign(
        result.error instanceof Error
          ? result.error
          : new Error(
              `Release Decision artifact download failed${
                stderr.trim() ? `: ${stderr.trim().slice(0, 500)}` : ""
              }`,
            ),
        {
          signal: result.signal,
          status: result.status,
          stderr,
        },
      );
      if (classifyReleaseGhTransportError(downloadError) === "transient") {
        console.warn(
          `Release Decision artifact unavailable this poll; retrying: ${downloadError.message}`,
        );
        return undefined;
      }
      throw new Error(
        `Release Decision artifact download failed${
          stderr.trim() ? `: ${stderr.trim().slice(0, 500)}` : ""
        }`,
        { cause: downloadError },
      );
    }
    const decisionPath = join(downloadDir, entryName);
    if (!existsSync(decisionPath)) {
      throw new Error(`Release Decision artifact ${artifactName} omitted ${entryName}.`);
    }
    if (statSync(decisionPath).size > MAX_RELEASE_ARTIFACT_BYTES) {
      throw new Error(`Release Decision artifact ${artifactName} exceeds the size limit.`);
    }
    const payload: unknown = JSON.parse(readFileSync(decisionPath, "utf8"));
    return payload;
  } finally {
    rmSync(downloadDir, { force: true, recursive: true });
  }
}

export function tryReadReleaseDecision(
  parentRunId: string,
  parentRunAttempt: number,
  workflowSha: string,
  runStatusImpl?: (command: string, args: string[], options?: CommandOptions) => CommandStatus,
) {
  const payload = readReleaseDecisionArtifact(
    parentRunId,
    `full-release-decision-${parentRunId}-${parentRunAttempt}`,
    RELEASE_DECISION_FILE,
    runStatusImpl,
  );
  if (payload === undefined) {
    return undefined;
  }
  return validateReleaseDecisionPayload(payload, {
    parentRunAttempt,
    parentRunId,
    workflowSha,
  });
}

function releaseDecisionAvailable(parentRunId: string, parentRunAttempt: number) {
  const artifactName = `full-release-decision-${parentRunId}-${parentRunAttempt}`;
  try {
    const response: unknown = JSON.parse(
      readGhApi(
        `repos/${REPOSITORY}/actions/runs/${parentRunId}/artifacts`,
        ["-f", "per_page=100", "-f", `name=${artifactName}`],
        { ...GH_READ_OPTIONS, stdio: ["ignore", "pipe", "pipe"] },
      ),
    );
    if (!isJsonRecord(response) || !Array.isArray(response.artifacts)) {
      throw new Error(`Full Release Validation run ${parentRunId} returned invalid artifacts`);
    }
    return response.artifacts.some(
      (artifact) =>
        isJsonRecord(artifact) && artifact.name === artifactName && artifact.expired === false,
    );
  } catch (error) {
    if (classifyReleaseGhTransportError(error) !== "transient") {
      throw error;
    }
    console.warn(`Release Decision metadata unavailable this poll; retrying: ${String(error)}`);
    return false;
  }
}

function waitForWorkflowRun(parentRunId: string, workflowSha: string, record?: DispatchRecord) {
  let lastSummary = "";
  let consecutiveErrors = 0;
  const startedAt = Date.now();
  const deadline = startedAt + FULL_RELEASE_WAIT_TIMEOUT_MINUTES * 60_000;
  let nextProgressAt = startedAt + FULL_RELEASE_PROGRESS_INTERVAL_MS;
  let decision: { attempt: number; state: "unavailable" | "ready" | "passed" } | undefined;
  while (Date.now() < deadline) {
    let suite: Record<string, unknown> | undefined;
    try {
      suite = readWorkflowRun(parentRunId, workflowSha);
      consecutiveErrors = 0;
    } catch (error) {
      consecutiveErrors += 1;
      if (consecutiveErrors >= 3) {
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`Parent run status query failed; retrying: ${message}`);
    }

    const status = stringValue(suite?.status, "pending").toLowerCase();
    const conclusion = stringValue(suite?.conclusion, "pending").toLowerCase();
    const summary = `${status}/${conclusion}`;
    if (summary !== lastSummary) {
      console.log(`Parent run status: ${summary}`);
      lastSummary = summary;
    }
    if (suite) {
      if (record?.run) {
        assertDispatchRun(suite, record.request, record.run);
      }
      const attempt = requiredPositiveInteger(suite.run_attempt, "parent run attempt");
      if (decision?.attempt !== attempt) {
        decision = { attempt, state: "unavailable" };
      }
      // Metadata is only a readiness hint. Once advertised, keep trying the
      // authoritative download across status regressions until this attempt validates.
      if (
        decision.state === "unavailable" &&
        (suite.status === "completed" || releaseDecisionAvailable(parentRunId, attempt))
      ) {
        decision.state = "ready";
      }
      if (decision.state === "ready") {
        const releaseDecision = tryReadReleaseDecision(parentRunId, attempt, workflowSha);
        if (releaseDecision && releaseDecisionStopsForeground(releaseDecision.state)) {
          throw new Error(
            `${formatReleaseStateOutcome(releaseDecision)}\nhttps://github.com/openclaw/openclaw/actions/runs/${parentRunId}`,
          );
        }
        // The workflow uploads one immutable decision per attempt; final success
        // still requires the parent's terminal conclusion and strict evidence verifier.
        if (releaseDecision?.state === "passed") {
          decision.state = "passed";
        }
      }
    }
    if (suite?.status === "completed" && stringValue(suite.conclusion)) {
      if (suite.conclusion === "success") {
        return suite;
      }
      throw new Error(
        `Full Release Validation concluded ${stringValue(suite.conclusion, "unknown").toLowerCase()}: https://github.com/openclaw/openclaw/actions/runs/${parentRunId}`,
      );
    }
    const now = Date.now();
    if (now >= nextProgressAt) {
      const elapsedMinutes = Math.floor((now - startedAt) / 60_000);
      try {
        const activeJobs = readActiveParentJobs(parentRunId);
        console.log(
          `Parent run progress after ${elapsedMinutes}m: ${activeJobs.length} active job(s)`,
        );
        for (const job of activeJobs) {
          console.log(`- ${job.name}: ${job.status}${job.url ? ` ${job.url}` : ""}`);
        }
      } catch (error) {
        console.warn(
          `Parent run progress query failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      nextProgressAt = now + FULL_RELEASE_PROGRESS_INTERVAL_MS;
    }
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      break;
    }
    Atomics.wait(
      new Int32Array(new SharedArrayBuffer(4)),
      0,
      0,
      Math.min(FULL_RELEASE_GITHUB_POLL_INTERVAL_MS, remainingMs),
    );
  }
  throw new Error(
    `Timed out after ${FULL_RELEASE_WAIT_TIMEOUT_MINUTES} minutes waiting for Full Release Validation: https://github.com/openclaw/openclaw/actions/runs/${parentRunId}`,
  );
}

export function releaseEvidenceVerificationArgs(
  parentRunId: unknown,
  verifierSourceSha: string,
  verifierSourceFile: string,
  trustedWorkflowRef = "main",
) {
  if (!/^[1-9][0-9]*$/u.test(String(parentRunId))) {
    throw new Error("parent run ID must be a positive decimal");
  }
  const trustedWorkflowFullRef =
    trustedWorkflowRef === "main"
      ? "refs/heads/main"
      : TRUSTED_WORKFLOW_TAG_PATTERN.test(trustedWorkflowRef)
        ? `refs/tags/${trustedWorkflowRef}`
        : "";
  if (!trustedWorkflowFullRef) {
    throw new Error("trusted workflow ref must be main or a protected release-publish tag");
  }
  return [
    "--validate-run",
    String(parentRunId),
    "--trusted-workflow-ref",
    trustedWorkflowRef,
    "--trusted-workflow-full-ref",
    trustedWorkflowFullRef,
    "--trusted-workflow-sha",
    verifierSourceSha,
    "--json",
    "--verifier-source-sha",
    verifierSourceSha,
    "--verifier-source-file",
    verifierSourceFile,
  ];
}

export function shouldDeleteTemporaryWorkflowRef(params: TemporaryRefParams) {
  return (
    !params.keepBranch &&
    (params.dryRun || (params.parentConclusion === "success" && params.evidenceVerified))
  );
}

export function assertTrustedWorkflowHarness(
  workflowSha: string,
  pathExists: (relativePath: string) => boolean = (relativePath) =>
    runStatus("git", ["cat-file", "-e", `${workflowSha}:${relativePath}`], {
      stdio: ["ignore", "ignore", "ignore"],
    }).status === 0,
  readPath: (relativePath: string) => string = (relativePath) =>
    run("git", ["show", `${workflowSha}:${relativePath}`]),
): TrustedWorkflowHarness {
  if (!pathExists(TRUSTED_WORKFLOW_PATH)) {
    throw new Error(
      `trusted workflow SHA ${workflowSha} does not contain ${TRUSTED_WORKFLOW_PATH}`,
    );
  }
  let workflow: unknown;
  try {
    workflow = parseYaml(readPath(TRUSTED_WORKFLOW_PATH));
  } catch (error) {
    throw new Error(
      `Tooling SHA ${workflowSha} contains invalid ${TRUSTED_WORKFLOW_PATH}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  const contract =
    isJsonRecord(workflow) && isJsonRecord(workflow.env)
      ? workflow.env[RELEASE_ISOLATION_TOOLING_CONTRACT_ENV]
      : undefined;
  if (contract !== "1" && contract !== RELEASE_ISOLATION_TOOLING_CONTRACT) {
    throw new Error(
      `Tooling SHA ${workflowSha} does not declare a supported ${RELEASE_ISOLATION_TOOLING_CONTRACT_ENV} in ${TRUSTED_WORKFLOW_PATH}`,
    );
  }
  const workflowInputs =
    isJsonRecord(workflow) &&
    isJsonRecord(workflow.on) &&
    isJsonRecord(workflow.on.workflow_dispatch) &&
    isJsonRecord(workflow.on.workflow_dispatch.inputs)
      ? workflow.on.workflow_dispatch.inputs
      : undefined;
  if (!workflowInputs || !Object.hasOwn(workflowInputs, "expected_sha")) {
    throw new Error(
      `Tooling SHA ${workflowSha} is missing workflow_dispatch input expected_sha in ${TRUSTED_WORKFLOW_PATH}`,
    );
  }
  if (
    contract === RELEASE_ISOLATION_TOOLING_CONTRACT &&
    !Object.hasOwn(workflowInputs, "trusted_workflow_json")
  ) {
    throw new Error(
      `Tooling SHA ${workflowSha} declares ${RELEASE_ISOLATION_TOOLING_CONTRACT_ENV}=2 but is missing workflow_dispatch input trusted_workflow_json in ${TRUSTED_WORKFLOW_PATH}`,
    );
  }
  const verifierPath = RELEASE_EVIDENCE_VERIFIER_PATHS.find((relativePath) =>
    pathExists(relativePath),
  );
  if (!verifierPath) {
    throw new Error(
      `trusted workflow SHA ${workflowSha} does not contain a supported release evidence verifier`,
    );
  }
  return { contract, verifierPath };
}

export function releaseEvidenceVerifierPath(worktreeRoot: string) {
  const candidates = RELEASE_EVIDENCE_VERIFIER_PATHS.map((relativePath) =>
    join(worktreeRoot, relativePath),
  );
  const verifier = candidates.find((candidate) => existsSync(candidate));
  if (!verifier) {
    throw new Error("trusted workflow checkout does not contain a release evidence verifier");
  }
  return verifier;
}

function verifyReleaseEvidence(
  parentRunId: string,
  workflowSha: string,
  trustedWorkflowRef: string,
) {
  const verifierWorktree = mkdtempSync(join(tmpdir(), "openclaw-release-verifier-"));
  try {
    run("git", ["worktree", "add", "--detach", verifierWorktree, workflowSha], {
      stdio: ["ignore", "ignore", "inherit"],
    });
    const verifier = releaseEvidenceVerifierPath(verifierWorktree);
    const evidence: unknown = JSON.parse(
      run(process.execPath, [
        verifier,
        ...releaseEvidenceVerificationArgs(parentRunId, workflowSha, verifier, trustedWorkflowRef),
      ]),
    );
    if (
      !isJsonRecord(evidence) ||
      evidence.valid !== true ||
      !isJsonRecord(evidence.current) ||
      !isJsonRecord(evidence.root)
    ) {
      throw new Error(`Full Release Validation evidence is invalid for run ${parentRunId}.`);
    }
    console.log(
      `ok release evidence current=${displayValue(evidence.current.runId)} root=${displayValue(evidence.root.runId)} reused=${Boolean(evidence.evidenceReuse)}`,
    );
  } finally {
    runStatus("git", ["worktree", "remove", "--force", verifierWorktree], {
      stdio: ["ignore", "ignore", "ignore"],
    });
    rmSync(verifierWorktree, { force: true, recursive: true });
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);
  if (args.resumeRequest) {
    const retained = readDispatchRecord(args.resumeRequest);
    if (retained.phase !== "prepared") {
      await reopenDispatch(args.resumeRequest, args, argv);
      return;
    }
    requireDispatch(
      retained.kind === CANDIDATE_REQUEST_KIND && retained.refs.workflow === "intended",
      "Only a candidate request with no qualification ref mutation can resume; reconcile uncertain work read-only",
    );
    args.trustedWorkflowRef = "candidate";
    args.admissionWorkflowRef = retained.admission!.workflowRef;
    await executeFrozenDispatch({
      args,
      record: retained,
      requestPath: resolve(args.resumeRequest),
      workflowSha: retained.request.workflowSha,
      branch: retained.request.workflowRef,
      selection: {
        inputs: retained.request.inputs,
        wireInputs: retained.request.wireInputs,
        effectiveSoak: retained.request.effectiveSoak,
      },
      admissionWorkflowSha: retained.admission!.workflowSha,
    });
    return;
  }
  const reopenPath = args.reconcileRequest || args.requestFile;
  if (reopenPath) {
    assertRequestPath(reopenPath);
    if (args.reconcileRequest || existsSync(reopenPath)) {
      await reopenDispatch(reopenPath, args, argv);
      return;
    }
  }
  requireDispatch(
    args.trustedWorkflowRef === "candidate" || args.inputs.validation_purpose !== "publish",
    "Fresh publication qualification must use candidate-owned Q=C; explicit cross-revision tooling is diagnostic only. Reconcile historical requests by their retained file.",
  );
  const targetSha = resolveTargetSha(args.sha, args.targetRef);
  preflightTargetShaFetch(targetSha);
  const targetVersion = targetVersionForTarget(targetSha);
  const targetProfile = releaseProfileForVersion(targetVersion);
  args.inputs.release_profile ??= targetProfile;
  args.inputs.allow_unreleased_changelog ??= args.targetRef ? "false" : "true";
  const targetContextRef = verifyTargetRef(args.targetRef, targetSha, targetVersion);
  const candidateOwned = args.trustedWorkflowRef === "candidate";
  const workflowSha = candidateOwned
    ? resolveSha(args.workflowSha || targetSha)
    : resolveTrustedWorkflowSha(args.workflowSha, args.trustedWorkflowRef);
  requireDispatch(
    !candidateOwned || workflowSha === targetSha,
    "Candidate-owned qualification requires Q=C; backport qualification repairs into a new candidate",
  );
  const trustedWorkflowHarness = assertTrustedWorkflowHarness(workflowSha);
  if (candidateOwned) {
    const workflow = parseYaml(run("git", ["show", `${workflowSha}:${TRUSTED_WORKFLOW_PATH}`]));
    requireDispatch(
      workflow?.env?.FULL_RELEASE_QUALIFICATION_ADMISSION_CONTRACT === "1",
      "Candidate lacks the frozen qualification admission contract; deliberately backport it, never fall back to main",
    );
  }
  const admissionWorkflowSha = candidateOwned
    ? resolveTrustedWorkflowSha(args.admissionWorkflowSha, args.admissionWorkflowRef)
    : undefined;
  if (admissionWorkflowSha) {
    assertAdmissionContract(admissionWorkflowSha);
  }
  if (candidateOwned) {
    const baselinePolicy: unknown = JSON.parse(
      run("git", ["show", `${workflowSha}:scripts/lib/upgrade-survivor-scenarios.json`]),
    );
    requireDispatch(
      isJsonRecord(baselinePolicy) &&
        (baselinePolicy.oldestSupportedBaseline === null ||
          typeof baselinePolicy.oldestSupportedBaseline === "string"),
      "Candidate is missing its data-owned upgrade baseline policy; deliberately backport the qualification contract",
    );
    const publishedVersions: unknown = JSON.parse(
      run("npm", ["view", "openclaw", "versions", "--json", "--silent", "--prefer-online"]),
    );
    requireDispatch(
      Array.isArray(publishedVersions) &&
        publishedVersions.every((entry) => typeof entry === "string"),
      "npm did not return the published baseline version inventory",
    );
    args.inputs.qualification_baselines_json = JSON.stringify(
      resolveQualificationBaselines({
        candidateVersion: targetVersion,
        targetContextRef,
        publishedVersions,
        oldestSupportedVersion: baselinePolicy.oldestSupportedBaseline,
      }),
    );
  }
  // Read target blobs with trusted tooling before creating the workflow ref.
  validatePackageSourceRef(targetSha, {
    allowUnreleasedChangelog: args.inputs.allow_unreleased_changelog === "true",
  });
  if (trustedWorkflowHarness.contract === "1") {
    args.inputs.reuse_evidence = "false";
  }
  const shortSha = workflowSha.slice(0, 12);
  const branch = `release-ci/${shortSha}-${Date.now()}`;
  const remoteBranchRef = `refs/heads/${branch}`;
  const dispatchInputs = {
    ref: targetSha,
    expected_sha: targetSha,
    ...(trustedWorkflowHarness.contract === RELEASE_ISOLATION_TOOLING_CONTRACT
      ? {
          trusted_workflow_json: JSON.stringify({
            fullRef: candidateOwned
              ? remoteBranchRef
              : args.trustedWorkflowRef === "main"
                ? "refs/heads/main"
                : `refs/tags/${args.trustedWorkflowRef}`,
            ref: candidateOwned ? branch : args.trustedWorkflowRef,
            sha: workflowSha,
          }),
        }
      : {}),
    ...(targetContextRef !== targetSha ? { target_context_ref: targetContextRef } : {}),
    ...args.inputs,
  };
  const selection = resolveDispatchSelection(workflowSha, dispatchInputs);
  const requestId = randomUUID();
  const requestPath = resolve(
    args.requestFile || join(".artifacts", "full-release-validation", `${requestId}.json`),
  );
  let record: DispatchRecord | undefined;
  if (!args.dryRun) {
    const workflow: unknown = JSON.parse(
      readGhApi(`repos/${REPOSITORY}/actions/workflows/${WORKFLOW}`),
    );
    requireDispatch(
      isJsonRecord(workflow) &&
        workflow.path === TRUSTED_WORKFLOW_PATH &&
        Number.isSafeInteger(workflow.id) &&
        Number(workflow.id) > 0,
      "Workflow metadata does not match the pinned workflow path",
    );
    let admission: QualificationAdmissionDispatch | undefined;
    if (admissionWorkflowSha) {
      const metadata: unknown = JSON.parse(
        readGhApi(`repos/${REPOSITORY}/actions/workflows/${ADMISSION_WORKFLOW}`),
      );
      requireDispatch(
        isJsonRecord(metadata) &&
          metadata.path === `.github/workflows/${ADMISSION_WORKFLOW}` &&
          Number.isSafeInteger(metadata.id) &&
          Number(metadata.id) > 0,
        "Admission workflow metadata mismatch",
      );
      admission = {
        request: buildQualificationAdmissionRequest({
          repository: REPOSITORY,
          candidateSha: targetSha,
          qualificationSha: workflowSha,
          requestId,
          transportRef: branch,
          reviewed: true,
          inputs: selection.wireInputs,
        }),
        workflowSha: admissionWorkflowSha,
        workflowRef: args.admissionWorkflowRef,
        workflowId: Number(metadata.id),
        phase: "prepared",
        run: null,
        descriptor: null,
      };
    }
    record = {
      kind: candidateOwned ? CANDIDATE_REQUEST_KIND : REQUEST_KIND,
      ...(admission ? { admission } : {}),
      request: {
        id: requestId,
        host: "github.com",
        repository: REPOSITORY,
        workflowId: Number(workflow.id),
        workflowPath: TRUSTED_WORKFLOW_PATH,
        event: "workflow_dispatch",
        workflowSha,
        trustedWorkflowRef: args.trustedWorkflowRef,
        targetSha,
        targetVersion,
        targetContextRef,
        workflowRef: branch,
        ...selection,
      },
      phase: "prepared",
      refs: { workflow: "intended" },
      error: "none",
      run: null,
    };
    retainDispatchRecord(requestPath, record);
  }

  console.log(`Request artifact: ${requestPath}${args.dryRun ? " (dry run; not written)" : ""}`);
  console.log(`Validation SHA: ${targetSha}`);
  console.log(`Tooling SHA: ${workflowSha}`);
  console.log(`Trusted workflow ref: ${args.trustedWorkflowRef}`);
  console.log(`Temporary workflow ref: ${branch}`);

  await executeFrozenDispatch({
    args,
    record,
    requestPath,
    workflowSha,
    branch,
    selection,
    admissionWorkflowSha,
  });
}

async function executeFrozenDispatch(options: {
  args: ReturnType<typeof parseArgs>;
  record: DispatchRecord | undefined;
  requestPath: string;
  workflowSha: string;
  branch: string;
  selection: ReturnType<typeof resolveDispatchSelection>;
  admissionWorkflowSha?: string;
}) {
  const { args, requestPath, workflowSha, branch, admissionWorkflowSha } = options;
  let { record, selection } = options;
  console.log(
    formatDispatchSelection(
      record?.request ?? { targetSha: String(selection.inputs.ref), workflowSha, ...selection },
    ),
  );
  const candidateOwned = args.trustedWorkflowRef === "candidate";
  const remoteBranchRef = `refs/heads/${branch}`;
  let parentRunId: string | undefined;
  let parentConclusion = "";
  let evidenceVerified = false;
  let workflowRefCreated = false;
  let dispatchAttempted = false;
  let operationError: Error | undefined;
  const retain = (next: DispatchRecord) => {
    retainDispatchRecord(requestPath, next, record);
    record = next;
  };
  try {
    if (record?.admission) {
      record = await qualifyAdmission(record, retain, qualificationDispatchClient);
      selection = {
        inputs: record.request.inputs,
        wireInputs: record.request.wireInputs,
        effectiveSoak: record.request.effectiveSoak,
      };
    } else if (candidateOwned && args.dryRun) {
      console.log(
        `Admission P: ${args.admissionWorkflowRef} at ${admissionWorkflowSha}; reviewed C=Q request (dry run)`,
      );
    }
    let payloadDirectory: string | undefined;
    let dispatchOutput = "";
    let dispatchError: unknown;
    try {
      let payloadPath = "";
      if (!args.dryRun) {
        const payload = JSON.stringify({ ref: branch, inputs: selection.wireInputs });
        requireDispatch(
          Buffer.byteLength(payload) <= MAX_REQUEST_BYTES &&
            Buffer.byteLength(JSON.stringify(selection.wireInputs)) <= 65_535,
          "Dispatch payload exceeds its byte limit",
        );
        payloadDirectory = mkdtempSync(join(tmpdir(), "openclaw-release-dispatch-payload-"));
        payloadPath = join(payloadDirectory, "dispatch.json");
        writeFileSync(payloadPath, payload, { flag: "wx", mode: 0o600 });
      }
      if (record) {
        retain({ ...record, refs: { workflow: "uncertain" } });
      }
      createTemporaryRef(remoteBranchRef, workflowSha, args.dryRun);
      workflowRefCreated = true;
      if (!args.dryRun && candidateOwned) {
        const pinned: unknown = JSON.parse(
          readGhApi(`repos/${REPOSITORY}/git/ref/heads/${branch}`),
        );
        requireDispatch(
          isJsonRecord(pinned) &&
            pinned.ref === remoteBranchRef &&
            isJsonRecord(pinned.object) &&
            pinned.object.type === "commit" &&
            pinned.object.sha === workflowSha,
          "Candidate qualification transport ref moved before dispatch",
        );
      }
      if (record) {
        retain({ ...record, phase: "attempted", refs: { workflow: "created" } });
      }
      const dispatchArgs = [
        "api",
        "--include",
        "--method",
        "POST",
        `repos/${REPOSITORY}/actions/workflows/${WORKFLOW}/dispatches`,
        "--hostname",
        "github.com",
        "--input",
        payloadPath,
      ];

      // Once dispatch starts, the workflow ref may be needed for GitHub reruns even when
      // the client loses the response. Cleanup resumes only after verified success.
      dispatchAttempted = true;
      try {
        if (args.dryRun) {
          console.log(
            `+ gh api --method POST repos/${REPOSITORY}/actions/workflows/${WORKFLOW}/dispatches (input values omitted)`,
          );
        } else {
          dispatchOutput = runGh(dispatchArgs, { stdio: ["ignore", "pipe", "pipe"] });
        }
      } catch (error) {
        dispatchError = error;
        dispatchOutput =
          error instanceof Error && "stdout" in error ? stringValue(error.stdout) : "";
      }
    } finally {
      if (payloadDirectory) {
        try {
          rmSync(payloadDirectory, { recursive: true, force: true });
        } catch {
          // A local cleanup failure must not change the observed POST outcome.
          console.warn(
            `Could not remove dispatch payload directory: ${JSON.stringify(payloadDirectory)}`,
          );
        }
      }
    }
    if (record) {
      let responseStatus = 0;
      try {
        responseStatus = parseGhHttpResponse(dispatchOutput).status;
      } catch {
        // A missing or partial response is not evidence that GitHub rejected the POST.
      }
      if ([400, 401, 403, 404, 422].includes(responseStatus)) {
        retain({ ...record, phase: "rejected", error: "http-rejection" });
        throw new Error(`dispatch=rejected: GitHub returned HTTP ${responseStatus}`);
      }
      if (dispatchError || responseStatus !== 204) {
        retain({
          ...record,
          error:
            classifyReleaseGhTransportError(dispatchError) === "transient"
              ? "transport"
              : "unclassified",
        });
      }
      const observed = await reconcileDispatch(record);
      retain({ ...record, phase: "observed", run: observed });
      parentRunId = String(observed.id);
      console.log(`dispatch=observed: attempt=${observed.attempt}`);
    }
    if (parentRunId) {
      console.log(`Parent run: https://github.com/openclaw/openclaw/actions/runs/${parentRunId}`);
      waitForWorkflowRun(parentRunId, workflowSha, record);
      parentConclusion = "success";
      verifyReleaseEvidence(
        parentRunId,
        // Admission may have advanced P with main before its POST.
        record?.admission?.workflowSha ?? admissionWorkflowSha ?? workflowSha,
        candidateOwned ? args.admissionWorkflowRef : args.trustedWorkflowRef,
      );
      evidenceVerified = true;
    }
  } catch (error) {
    operationError = error instanceof Error ? error : new Error(String(error));
    if (record) {
      console.error(
        `dispatch=${record.phase === "rejected" ? "rejected" : record.phase === "observed" ? "observed" : "unknown"} error=${record.error}`,
      );
      console.error(`Retained workflow ref: ${remoteBranchRef}`);
      console.error(
        `node scripts/full-release-validation-at-sha.mjs --reconcile-request ${JSON.stringify(requestPath)}`,
      );
    }
  }

  const cleanupBeforeDispatch =
    !dispatchAttempted && workflowRefCreated && record?.refs.workflow !== "uncertain";
  const cleanupAfterSuccess = shouldDeleteTemporaryWorkflowRef({
    keepBranch: args.keepBranch,
    dryRun: args.dryRun,
    parentConclusion,
    evidenceVerified,
  });
  let cleanupError: Error | undefined;
  if (workflowRefCreated && (cleanupBeforeDispatch || cleanupAfterSuccess)) {
    try {
      deleteTemporaryRef(remoteBranchRef, args.dryRun);
    } catch (error) {
      cleanupError = error instanceof Error ? error : new Error(String(error));
    }
  } else if (workflowRefCreated) {
    console.warn(
      args.keepBranch
        ? `Kept ${remoteBranchRef}`
        : `Kept ${remoteBranchRef}: ${
            parentConclusion === "success"
              ? "release evidence was not verified"
              : `parent concluded ${parentConclusion || "without a conclusion"}`
          }. Keep it through GitHub reruns or evidence diagnosis; delete it after verified success.`,
    );
  }

  if (operationError && cleanupError) {
    throw new Error(
      `${commandFailureMessage(operationError)}; temporary ref cleanup also failed: ${commandFailureMessage(cleanupError)}`,
      { cause: new AggregateError([operationError, cleanupError]) },
    );
  }
  if (operationError) {
    throw operationError;
  }
  if (cleanupError) {
    throw cleanupError;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (error) {
    console.error(
      `[full-release-validation] FAILED: ${error instanceof Error ? error.message : String(error)}`,
    );
    console.error("[full-release-validation] FAILED (exit 1)");
    process.exitCode = 1;
  }
}
