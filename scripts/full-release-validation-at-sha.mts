#!/usr/bin/env node
// Dispatches full release validation against a temporary SHA-pinned branch.
import {
  execFileSync,
  spawnSync,
  type ExecFileSyncOptionsWithStringEncoding,
} from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { parse as parseYaml } from "yaml";
import { isRecord as isJsonRecord } from "../packages/normalization-core/src/record-coerce.ts";
import {
  classifyReleaseGhTransportError,
  formatReleaseStateOutcome,
  isReleaseGhArtifactMissingError,
  MAX_RELEASE_ARTIFACT_BYTES,
  validateReleaseStateArtifact,
} from "./full-release-validation-policy.mjs";
import {
  inspectActionsArtifactZipWithPolicy,
  readBoundedRegularFile,
} from "./lib/actions-artifact-archive.mjs";
import { requireOptionArgument } from "./lib/arg-utils.mts";
import { execPlainGh } from "./lib/plain-gh.mjs";
import { parseReleaseContextRef, resolveReleaseContextIdentity } from "./lib/release-context.mjs";
import { validatePackageSourceRef } from "./package-source-preflight.mjs";

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
export const FULL_RELEASE_GITHUB_POLL_INTERVAL_MS = 2 * 60_000;
const FULL_RELEASE_PROGRESS_INTERVAL_MS = 15 * 60_000;
const FULL_RELEASE_RUN_DISCOVERY_DELAYS_MS = [30_000, 60_000, 120_000];
const RELEASE_DECISION_FILE = "full-release-decision.json";
const GH_NO_CACHE_HEADER = "Cache-Control: max-age=0";
const REQUEST_KIND = "openclaw.full-release-dispatch/v1";
const WITNESS_KIND = "openclaw.full-release-dispatch-inputs/v1";
const WITNESS_FILE = "dispatch-inputs.json";
const MAX_REQUEST_BYTES = 128 * 1024;
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
type DispatchInputs = Record<string, string | boolean | number>;
type DispatchRun = { id: number; attempt: number };
type DispatchRequest = {
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
  targetRef: string;
  wireInputs: Record<string, string>;
  inputs: DispatchInputs;
  effectiveSoak: boolean;
};
type DispatchRecord = {
  kind: typeof REQUEST_KIND;
  request: DispatchRequest;
  phase: "prepared" | "attempted" | "observed" | "rejected";
  refs: {
    target: "intended" | "uncertain" | "created";
    workflow: "intended" | "uncertain" | "created";
  };
  error: "none" | "transport" | "unclassified" | "http-rejection";
  run: DispatchRun | null;
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
  console.error(`Usage: node scripts/full-release-validation-at-sha.mjs [--sha <target-sha>] [--target-ref <canonical-release-branch-or-tag>] [--workflow-sha <trusted-tooling-sha>] [--trusted-workflow-ref <main-or-release-publish-tag>] [--request-file <path>] [--keep-branch] [--dry-run] [-- -f key=value ...]
       node scripts/full-release-validation-at-sha.mjs --reconcile-request <path>

Retains a private request artifact before remote mutations. An existing --request-file
always performs read-only reconciliation. --reconcile-request refuses a missing file.
Retain the artifact until operator cleanup; its loss never proves non-execution.
Frozen tooling must declare FULL_RELEASE_DISPATCH_WITNESS_CONTRACT=1 before a new request.

Creates temporary remote branches pinned to the exact Tooling SHA and Validation SHA,
dispatches Full Release Validation with the full Validation SHA as its ref input
and expected_sha as its immutable identity,
watches the parent run, verifies all child workflow head SHAs match the trusted
workflow lineage through the release evidence manifest, then deletes both
temporary branches by default. --keep-branch retains both branches. Exact-target and changelog-only Release SHA
evidence reuse stay enabled; pass -f reuse_evidence=false to force a fresh
run. Child workflows collect independent failures by default; pass
-f fail_fast=true to cancel only an exact still-active child after Release
Decision identifies a blocking failure for that child. The release
branch accepts its final package version or a matching beta prerelease.
A numeric correction branch also accepts the base package only when its
published base tag resolves to the exact Validation SHA.
Exact alpha tags remain supported for Tideclaw. The release profile defaults to
beta for beta candidates and exact alpha tags, and stable otherwise; pass
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

function runStatus(command: string, args: string[], options: CommandOptions = {}) {
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
    const message = commandFailureMessage(error);
    if (!message.includes("Object does not exist")) {
      throw new Error(message, { cause: error });
    }
    // The refs API cannot transfer a commit that exists only in the local
    // object database. Preserve the shipped local-candidate contract.
    run("git", ["push", "origin", `${sha}:${ref}`], {
      dryRun,
      stdio: "inherit",
    });
  }
}

function deleteTemporaryRefs(refs: string[], dryRun: boolean) {
  const failures: string[] = [];
  for (const ref of refs) {
    try {
      runGh(
        ["api", "--method", "DELETE", `repos/${REPOSITORY}/git/refs/${ref.slice("refs/".length)}`],
        {
          dryRun,
        },
      );
    } catch (error) {
      failures.push(`${ref}: ${commandFailureMessage(error)}`);
    }
  }
  if (failures.length > 0) {
    throw new Error(`Failed to delete temporary refs: ${failures.join("; ")}`);
  }
}

export function parseArgs(argv: string[]) {
  const inputs: ReleaseInputs = { ...DEFAULT_INPUTS };
  const args = {
    sha: "",
    targetRef: "",
    trustedWorkflowRef: "main",
    workflowSha: "",
    requestFile: "",
    reconcileRequest: "",
    specifiedInputs: [] as string[],
    keepBranch: false,
    dryRun: false,
    inputs,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--help" || arg === "-h") {
      usage();
      process.exit(0);
    }
    if (arg === "--sha") {
      args.sha = requireOptionArgument(argv, i, arg);
      i += 1;
      continue;
    }
    if (arg === "--request-file" || arg === "--reconcile-request") {
      args[arg === "--request-file" ? "requestFile" : "reconcileRequest"] = requireOptionArgument(
        argv,
        i,
        arg,
      );
      i += 1;
      continue;
    }
    if (arg === "--workflow-sha") {
      args.workflowSha = requireOptionArgument(argv, i, arg);
      i += 1;
      continue;
    }
    if (arg === "--trusted-workflow-ref") {
      args.trustedWorkflowRef = requireOptionArgument(argv, i, arg);
      i += 1;
      continue;
    }
    if (arg === "--target-ref") {
      args.targetRef = requireOptionArgument(argv, i, arg);
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
        const [key, ...valueParts] = assignment.split("=");
        if (!key || valueParts.length === 0) {
          throw new Error(`Unsupported extra argument after --: ${extra}`);
        }
        args.inputs[key] = valueParts.join("=");
        args.specifiedInputs.push(key);
      }
      break;
    }
    if (arg === "-f") {
      const assignment = requireOptionArgument(argv, i, arg);
      i += 1;
      const [key, ...valueParts] = assignment.split("=");
      if (!key || valueParts.length === 0) {
        throw new Error(`Invalid -f assignment: ${assignment}`);
      }
      args.inputs[key] = valueParts.join("=");
      args.specifiedInputs.push(key);
      continue;
    }
    if (arg.startsWith("-f") && arg.includes("=")) {
      const assignment = arg.slice(2).trim();
      const [key, ...valueParts] = assignment.split("=");
      if (!key || valueParts.length === 0) {
        throw new Error(`Invalid -f assignment: ${arg}`);
      }
      args.inputs[key] = valueParts.join("=");
      args.specifiedInputs.push(key);
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (args.reconcileRequest) {
    if (argv.length !== 2 || argv[0] !== "--reconcile-request") {
      throw new Error("--reconcile-request accepts only the retained request path");
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
  if (Object.hasOwn(args.inputs, "trusted_workflow_json")) {
    throw new Error("SHA-pinned release validation reserves trusted_workflow_json");
  }
  const targetContext = parseReleaseContextRef(args.targetRef);
  if (args.targetRef && !targetContext) {
    throw new Error("--target-ref must be a canonical OpenClaw release branch or tag");
  }
  args.targetRef = targetContext?.ref ?? args.targetRef;
  if (
    args.trustedWorkflowRef !== "main" &&
    !TRUSTED_WORKFLOW_TAG_PATTERN.test(args.trustedWorkflowRef)
  ) {
    throw new Error(
      "--trusted-workflow-ref must be main or a protected release-publish/<12hex>-<decimal> tag",
    );
  }
  if (args.trustedWorkflowRef !== "main" && !SHA_PATTERN.test(args.workflowSha.toLowerCase())) {
    throw new Error(
      "protected release-publish workflow refs require --workflow-sha with an explicit full Tooling SHA",
    );
  }
  if (
    targetContext &&
    targetContext.kind !== "release tag" &&
    !SHA_PATTERN.test(args.workflowSha.toLowerCase())
  ) {
    throw new Error(
      "release-branch validation requires --workflow-sha with an explicit full Tooling SHA",
    );
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

function targetVersionForTarget(
  targetSha: string,
  readPackageJson: (sha: string) => string = (sha) => run("git", ["show", `${sha}:package.json`]),
): string {
  let version: unknown;
  try {
    version = JSON.parse(readPackageJson(targetSha)).version;
  } catch {
    throw new Error(`Could not read package.json from target SHA ${targetSha}`);
  }
  if (typeof version !== "string" || !/^[0-9]{4}\.[0-9]+\.[0-9]+(?:-.+)?$/u.test(version)) {
    throw new Error(`Target SHA ${targetSha} has an invalid package version`);
  }
  return version;
}

function releaseProfileForVersion(version: string): "beta" | "stable" {
  return /-(?:alpha|beta)\.[1-9][0-9]*$/u.test(version) ? "beta" : "stable";
}

export function releaseProfileForTarget(
  targetSha: string,
  readPackageJson: (sha: string) => string = (sha) => run("git", ["show", `${sha}:package.json`]),
): "beta" | "stable" {
  return releaseProfileForVersion(targetVersionForTarget(targetSha, readPackageJson));
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

function requireDispatch(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function exactKeys(value: unknown, keys: string[]): value is Record<string, unknown> {
  return isJsonRecord(value) && isDeepStrictEqual(Object.keys(value).toSorted(), keys.toSorted());
}

export function dispatchInputsDigest(inputs: DispatchInputs): string {
  const wireInputs = Object.fromEntries(
    Object.keys(inputs)
      .toSorted()
      .map((key) => [key, String(inputs[key])]),
  );
  return `sha256:${createHash("sha256").update(JSON.stringify(wireInputs)).digest("hex")}`;
}

function validateDispatchRecord(value: unknown): asserts value is DispatchRecord {
  requireDispatch(
    exactKeys(value, ["kind", "request", "phase", "refs", "error", "run"]) &&
      value.kind === REQUEST_KIND &&
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
      "targetRef",
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
      (request.trustedWorkflowRef === "main" ||
        TRUSTED_WORKFLOW_TAG_PATTERN.test(request.trustedWorkflowRef)) &&
      typeof request.workflowRef === "string" &&
      new RegExp(`^release-ci/${request.workflowSha.slice(0, 12)}-[0-9]+$`, "u").test(
        request.workflowRef,
      ) &&
      typeof request.targetRef === "string" &&
      new RegExp(`^validation/target-${request.targetSha.slice(0, 12)}-[0-9]+$`, "u").test(
        request.targetRef,
      ) &&
      isJsonRecord(request.wireInputs) &&
      isJsonRecord(request.inputs) &&
      isDeepStrictEqual(
        Object.keys(request.wireInputs).toSorted(),
        Object.keys(request.inputs).toSorted(),
      ),
    "Invalid retained dispatch request identity",
  );
  for (const [key, input] of Object.entries(request.inputs)) {
    requireDispatch(
      /^[a-z][a-z0-9_]*$/u.test(key) &&
        (typeof input === "string" ||
          typeof input === "boolean" ||
          (typeof input === "number" && Number.isFinite(input))) &&
        request.wireInputs[key] === String(input),
      "Invalid retained dispatch inputs",
    );
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
      typeof request.inputs.trusted_workflow_json === "string" &&
        isDeepStrictEqual(JSON.parse(request.inputs.trusted_workflow_json), {
          fullRef:
            request.trustedWorkflowRef === "main"
              ? "refs/heads/main"
              : `refs/tags/${request.trustedWorkflowRef}`,
          ref: request.trustedWorkflowRef,
          sha: request.workflowSha,
        }),
      "Retained trusted workflow identity changed",
    );
  }
  requireDispatch(
    exactKeys(value.refs, ["target", "workflow"]) &&
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

function assertRequestPath(path: string) {
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

function readDispatchRecord(path: string): DispatchRecord {
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

function retainDispatchRecord(path: string, record: DispatchRecord, previous?: DispatchRecord) {
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
    isJsonRecord(workflow.on) &&
      isJsonRecord(workflow.on.workflow_dispatch) &&
      isJsonRecord(workflow.on.workflow_dispatch.inputs),
    "Pinned workflow input schema is invalid",
  );
  const definitions = workflow.on.workflow_dispatch.inputs;
  requireDispatch(
    Object.keys(overrides).every((key) => Object.hasOwn(definitions, key)),
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
      overrides[key] ?? definition.default ?? (definition.type === "boolean" ? false : "");
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
  const archiveBytes = execPlainGh(
    [
      "api",
      "--method",
      "GET",
      `${artifactEndpoint}/zip`,
      "--hostname",
      "github.com",
      "-H",
      GH_NO_CACHE_HEADER,
    ],
    { ...GH_READ_OPTIONS, encoding: null, maxBuffer: MAX_WITNESS_ARCHIVE_BYTES },
  );
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
  for (let attempt = 0; attempt <= FULL_RELEASE_RUN_DISCOVERY_DELAYS_MS.length; attempt += 1) {
    const runs = readDispatchRuns(request);
    if (runs.length > 0) {
      requireDispatch(
        runs.length === 1,
        "Multiple dispatch runs exist for the retained transport; adoption is ambiguous",
      );
      const observed = record.run ?? { id: Number(runs[0]!.id), attempt: 1 };
      assertDispatchRun(runs[0], request, observed);
      assertDispatchRun(
        JSON.parse(readGhApi(`repos/${REPOSITORY}/actions/runs/${observed.id}`)),
        request,
        observed,
      );
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
    if (attempt < FULL_RELEASE_RUN_DISCOVERY_DELAYS_MS.length) {
      Atomics.wait(
        new Int32Array(new SharedArrayBuffer(4)),
        0,
        0,
        FULL_RELEASE_RUN_DISCOVERY_DELAYS_MS[attempt],
      );
    }
  }
  throw new Error("Could not determine Full Release Validation run id: discovery exhausted");
}

async function reopenDispatch(path: string, args: ReturnType<typeof parseArgs>, argv: string[]) {
  const record = readDispatchRecord(path);
  const request = record.request;
  requireDispatch(
    (!args.sha || args.sha === request.targetSha) &&
      (!args.workflowSha || args.workflowSha === request.workflowSha) &&
      (!args.targetRef || args.targetRef === request.targetContextRef) &&
      (!argv.includes("--trusted-workflow-ref") ||
        args.trustedWorkflowRef === request.trustedWorkflowRef) &&
      args.specifiedInputs.every((key) => args.inputs[key] === request.wireInputs[key]),
    "Reopen arguments conflict with the retained request",
  );
  try {
    const observed = await reconcileDispatch(record);
    console.log(
      `dispatch=observed: https://github.com/${REPOSITORY}/actions/runs/${observed.id} attempt=${observed.attempt}`,
    );
  } catch (error) {
    console.error(
      `dispatch=${record.phase === "rejected" ? "rejected" : "unknown"} error=${record.error}`,
    );
    console.error(
      `Retained refs: refs/heads/${request.workflowRef} and refs/heads/${request.targetRef}`,
    );
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
  return validateReleaseStateArtifact(
    payload,
    {
      parentRunAttempt: expected.parentRunAttempt,
      parentRunId: expected.parentRunId,
      workflowSha: expected.workflowSha,
    },
    "decision",
  );
}

export function releaseDecisionStopsForeground(state: unknown) {
  return [
    "blocked_diagnostics_running",
    "blocked_complete",
    "orchestration_error",
    "cancelled_with_children",
  ].includes(stringValue(state));
}

export function tryReadReleaseDecision(
  parentRunId: string,
  parentRunAttempt: number,
  workflowSha: string,
  runStatusImpl: (command: string, args: string[], options?: CommandOptions) => CommandStatus = (
    _command,
    args,
    options,
  ) => runGhStatus(args, options),
) {
  const artifactName = `full-release-decision-${parentRunId}-${parentRunAttempt}`;
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
    const decisionPath = join(downloadDir, RELEASE_DECISION_FILE);
    if (!existsSync(decisionPath)) {
      throw new Error(
        `Release Decision artifact ${artifactName} omitted ${RELEASE_DECISION_FILE}.`,
      );
    }
    if (statSync(decisionPath).size > MAX_RELEASE_ARTIFACT_BYTES) {
      throw new Error(`Release Decision artifact ${artifactName} exceeds the size limit.`);
    }
    return validateReleaseDecisionPayload(JSON.parse(readFileSync(decisionPath, "utf8")), {
      parentRunAttempt,
      parentRunId,
      workflowSha,
    });
  } finally {
    rmSync(downloadDir, { force: true, recursive: true });
  }
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
  const reopenPath = args.reconcileRequest || args.requestFile;
  if (reopenPath) {
    assertRequestPath(reopenPath);
    if (args.reconcileRequest || existsSync(reopenPath)) {
      await reopenDispatch(reopenPath, args, argv);
      return;
    }
  }
  const targetSha = resolveTargetSha(args.sha, args.targetRef);
  const targetVersion = targetVersionForTarget(targetSha);
  args.inputs.release_profile ??= releaseProfileForVersion(targetVersion);
  args.inputs.allow_unreleased_changelog ??= args.targetRef ? "false" : "true";
  const targetContextRef = verifyTargetRef(args.targetRef, targetSha, targetVersion);
  const workflowSha = resolveTrustedWorkflowSha(args.workflowSha, args.trustedWorkflowRef);
  const trustedWorkflowHarness = assertTrustedWorkflowHarness(workflowSha);
  // Read target blobs with trusted tooling before creating remote transport refs.
  validatePackageSourceRef(targetSha, {
    allowUnreleasedChangelog: args.inputs.allow_unreleased_changelog === "true",
  });
  if (trustedWorkflowHarness.contract === "1") {
    args.inputs.reuse_evidence = "false";
  }
  const shortSha = workflowSha.slice(0, 12);
  const branch = `release-ci/${shortSha}-${Date.now()}`;
  const remoteBranchRef = `refs/heads/${branch}`;
  const targetBranch = `validation/target-${targetSha.slice(0, 12)}-${Date.now()}`;
  const remoteTargetBranchRef = `refs/heads/${targetBranch}`;
  const dispatchInputs = {
    ref: targetSha,
    expected_sha: targetSha,
    ...(trustedWorkflowHarness.contract === RELEASE_ISOLATION_TOOLING_CONTRACT
      ? {
          trusted_workflow_json: JSON.stringify({
            fullRef:
              args.trustedWorkflowRef === "main"
                ? "refs/heads/main"
                : `refs/tags/${args.trustedWorkflowRef}`,
            ref: args.trustedWorkflowRef,
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
    record = {
      kind: REQUEST_KIND,
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
        targetRef: targetBranch,
        ...selection,
      },
      phase: "prepared",
      refs: { target: "intended", workflow: "intended" },
      error: "none",
      run: null,
    };
    retainDispatchRecord(requestPath, record);
  }

  console.log(`Request artifact: ${requestPath}${args.dryRun ? " (dry run; not written)" : ""}`);
  console.log(`Validation SHA: ${targetSha}`);
  console.log(`Tooling SHA: ${workflowSha}`);
  console.log(`Trusted workflow ref: ${args.trustedWorkflowRef}`);
  console.log(
    `Frozen validation tuple: candidate=${targetSha} tooling=${workflowSha} rerun_group=${args.inputs.rerun_group}`,
  );
  console.log(`Temporary target ref: ${targetBranch}`);
  console.log(`Temporary workflow ref: ${branch}`);

  let parentRunId: string | undefined;
  let parentConclusion = "";
  let evidenceVerified = false;
  let targetRefCreated = false;
  let workflowRefCreated = false;
  let dispatchAttempted = false;
  let operationError: Error | undefined;
  const retain = (next: DispatchRecord) => {
    retainDispatchRecord(requestPath, next, record);
    record = next;
  };
  try {
    if (record) {
      retain({ ...record, refs: { ...record.refs, target: "uncertain" } });
    }
    createTemporaryRef(remoteTargetBranchRef, targetSha, args.dryRun);
    targetRefCreated = true;
    if (record) {
      retain({ ...record, refs: { ...record.refs, target: "created", workflow: "uncertain" } });
    }
    createTemporaryRef(remoteBranchRef, workflowSha, args.dryRun);
    workflowRefCreated = true;
    if (record) {
      retain({ ...record, phase: "attempted", refs: { target: "created", workflow: "created" } });
    }
    const dispatchArgs = [
      "api",
      "--include",
      "--method",
      "POST",
      `repos/${REPOSITORY}/actions/workflows/${WORKFLOW}/dispatches`,
      "--hostname",
      "github.com",
      "-f",
      `ref=${branch}`,
    ];
    for (const [key, value] of Object.entries(selection.wireInputs)) {
      dispatchArgs.push("-f", `inputs[${key}]=${value}`);
    }

    // Once dispatch starts, the refs may be needed for GitHub reruns even when
    // the client loses the response. Cleanup resumes only after verified success.
    dispatchAttempted = true;
    let dispatchOutput = "";
    let dispatchError: unknown;
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
      dispatchOutput = error instanceof Error && "stdout" in error ? stringValue(error.stdout) : "";
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
      const completedRun = waitForWorkflowRun(parentRunId, workflowSha, record);
      parentConclusion = stringValue(completedRun.conclusion);
      if (parentConclusion !== "success") {
        throw new Error(
          `Full Release Validation concluded ${parentConclusion.toLowerCase() || "without a conclusion"}: https://github.com/openclaw/openclaw/actions/runs/${parentRunId}`,
        );
      }
      verifyReleaseEvidence(parentRunId, workflowSha, args.trustedWorkflowRef);
      evidenceVerified = true;
    }
  } catch (error) {
    operationError = error instanceof Error ? error : new Error(String(error));
    if (record) {
      console.error(
        `dispatch=${record.phase === "rejected" ? "rejected" : record.phase === "observed" ? "observed" : "unknown"} error=${record.error}`,
      );
      console.error(`Retained refs: ${remoteBranchRef} and ${remoteTargetBranchRef}`);
      console.error(
        `node scripts/full-release-validation-at-sha.mjs --reconcile-request ${JSON.stringify(requestPath)}`,
      );
    }
  }

  const createdRefs = [
    ...(workflowRefCreated ? [remoteBranchRef] : []),
    ...(targetRefCreated ? [remoteTargetBranchRef] : []),
  ];
  const cleanupBeforeDispatch =
    !dispatchAttempted &&
    createdRefs.length > 0 &&
    !Object.values(record?.refs ?? {}).includes("uncertain");
  const cleanupAfterSuccess = shouldDeleteTemporaryWorkflowRef({
    keepBranch: args.keepBranch,
    dryRun: args.dryRun,
    parentConclusion,
    evidenceVerified,
  });
  let cleanupError: Error | undefined;
  if (cleanupBeforeDispatch || cleanupAfterSuccess) {
    try {
      deleteTemporaryRefs(createdRefs, args.dryRun);
    } catch (error) {
      cleanupError = error instanceof Error ? error : new Error(String(error));
    }
  } else if (createdRefs.length > 0) {
    const keptRefs = createdRefs.join(" and ");
    console.warn(
      args.keepBranch
        ? `Kept ${keptRefs}`
        : `Kept ${keptRefs}: ${
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
