#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const CONTRACT_VERSION = 1;
const REPOSITORY = "openclaw/openclaw";
const CANONICAL_FETCH_URL = "https://github.com/openclaw/openclaw.git";
const POLICY_MAIN_REF = "refs/heads/main";
const SHA_PATTERN = /^[0-9a-f]{40}$/u;
const DECIMAL_PATTERN = /^[1-9][0-9]*$/u;
const ALPHA_REF_PATTERN = /^refs\/heads\/tideclaw\/alpha\/\d{4}-\d{2}-\d{2}-\d{4}Z$/u;
const OPERATIONS = new Set([
  "tag-preflight",
  "sha-preflight",
  "internal-validation",
  "publish",
  "postpublish",
  "stable-closeout",
]);
const INPUT_KEYS = [
  "schemaVersion",
  "operation",
  "releaseVersion",
  "releaseSelector",
  "policyMode",
  "expectedPolicySourceSha",
  "execution",
  "target",
];
const EXECUTION_KEYS = [
  "event",
  "workflowPath",
  "executionRef",
  "runHeadSha",
  "runId",
  "runAttempt",
];
const TARGET_KEYS = ["targetRef", "targetSha", "releaseTag", "authorizedSourceRef"];
const POLICY_PATHS = {
  npmPublishPlan: "scripts/lib/npm-publish-plan.mjs",
  releaseVersionPolicy: "scripts/lib/release-version-policy.mjs",
  stableReleaseLines: "scripts/lib/stable-release-lines.mjs",
  releasePolicyEvidence: "scripts/lib/release-policy-evidence.mjs",
  verifier: "scripts/verify-release-operation.mjs",
  stableLines: "release/stable-lines.json",
};
const EXIT_BY_ERROR = new Map([
  ["invalid-arguments", 2],
  ["unsupported-contract-version", 2],
  ["invalid-input", 2],
  ["repository-identity-mismatch", 3],
  ["canonical-fetch-failed", 3],
  ["policy-source-mismatch", 3],
  ["policy-checkout-mismatch", 3],
  ["target-unavailable", 3],
  ["operation-not-allowed", 4],
  ["execution-not-authorized", 4],
  ["selector-mismatch", 4],
  ["metadata-invalid", 4],
  ["target-not-authorized", 4],
  ["target-not-reachable", 4],
  ["internal-error", 70],
]);

class VerificationError extends Error {
  constructor(code, reason) {
    super(reason);
    this.name = "VerificationError";
    this.code = code;
  }
}

function reject(code, reason) {
  throw new VerificationError(code, reason);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireClosedObject(value, keys, label) {
  if (!isRecord(value)) {
    reject("invalid-input", `${label} must be an object`);
  }
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) {
      reject("invalid-input", `${label} has an unknown field`);
    }
  }
  for (const key of keys) {
    if (!Object.hasOwn(value, key)) {
      reject("invalid-input", `${label} is missing a required field`);
    }
  }
  return value;
}

function requireString(value, label) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim() ||
    value.includes("\r") ||
    value.includes("\n") ||
    value.includes("\u0000")
  ) {
    reject("invalid-input", `${label} must be a non-empty single-line string`);
  }
  return value;
}

function requireSha(value, label) {
  if (typeof value !== "string" || !SHA_PATTERN.test(value)) {
    reject("invalid-input", `${label} must be a 40-character lowercase SHA`);
  }
  return value;
}

function requireDecimal(value, label) {
  if (typeof value !== "string" || !DECIMAL_PATTERN.test(value)) {
    reject("invalid-input", `${label} must be a positive decimal string`);
  }
  return value;
}

function parseVerifyArguments(args) {
  const allowed = new Set(["--contract-version", "--policy-root", "--input"]);
  const flags = {};
  if (args.length !== 6) {
    reject("invalid-arguments", "verify requires each v1 flag exactly once");
  }
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (
      !allowed.has(flag) ||
      value === undefined ||
      value.length === 0 ||
      Object.hasOwn(flags, flag)
    ) {
      reject("invalid-arguments", "verify requires each v1 flag exactly once");
    }
    flags[flag] = value;
  }
  if (flags["--contract-version"] !== "1") {
    reject("unsupported-contract-version", "only verifier contract version 1 is supported");
  }
  return {
    policyRoot: path.resolve(flags["--policy-root"]),
    inputPath: flags["--input"],
  };
}

function readInput(inputPath) {
  let bytes;
  try {
    bytes = inputPath === "-" ? readFileSync(0) : readFileSync(inputPath);
  } catch {
    reject("invalid-input", "input could not be read");
  }
  let input;
  try {
    input = JSON.parse(bytes.toString("utf8"));
  } catch {
    reject("invalid-input", "input must be valid JSON");
  }
  return validateInput(input);
}

function validateInput(value) {
  const input = requireClosedObject(value, INPUT_KEYS, "input");
  if (input.schemaVersion !== 1) {
    reject("unsupported-contract-version", "input schemaVersion must equal 1");
  }
  requireString(input.operation, "operation");
  if (!OPERATIONS.has(input.operation)) {
    reject("operation-not-allowed", "operation is not in the v1 allowlist");
  }
  requireString(input.releaseVersion, "releaseVersion");
  if (
    input.releaseSelector !== null &&
    !["alpha", "beta", "daily", "stable"].includes(input.releaseSelector)
  ) {
    reject("invalid-input", "releaseSelector is invalid");
  }
  if (input.policyMode !== "legacy" && input.policyMode !== "strict") {
    reject("invalid-input", "policyMode must be legacy or strict");
  }
  if (
    (input.policyMode === "legacy" && input.releaseSelector !== null) ||
    (input.policyMode === "strict" && input.releaseSelector === null)
  ) {
    reject("selector-mismatch", "releaseSelector does not satisfy policyMode");
  }
  requireSha(input.expectedPolicySourceSha, "expectedPolicySourceSha");

  const execution = requireClosedObject(input.execution, EXECUTION_KEYS, "execution");
  requireString(execution.event, "execution.event");
  requireString(execution.workflowPath, "execution.workflowPath");
  requireString(execution.executionRef, "execution.executionRef");
  requireSha(execution.runHeadSha, "execution.runHeadSha");
  requireDecimal(execution.runId, "execution.runId");
  requireDecimal(execution.runAttempt, "execution.runAttempt");

  const target = requireClosedObject(input.target, TARGET_KEYS, "target");
  requireSha(target.targetSha, "target.targetSha");
  const nullableKeys = ["targetRef", "releaseTag", "authorizedSourceRef"];
  for (const key of nullableKeys) {
    if (target[key] !== null) {
      requireString(target[key], `target.${key}`);
    }
  }
  validateTargetNullability(input.operation, target);
  validateOperationShape(input.operation, execution);
  return input;
}

function validateTargetNullability(operation, target) {
  if (operation === "sha-preflight") {
    if (
      target.targetRef !== null ||
      target.releaseTag !== null ||
      target.authorizedSourceRef !== null
    ) {
      reject("invalid-input", "sha-preflight target nullability is invalid");
    }
    return;
  }
  if (target.targetRef === null || target.authorizedSourceRef === null) {
    reject("invalid-input", "operation requires targetRef and authorizedSourceRef");
  }
  if (operation === "internal-validation") {
    if (target.releaseTag !== null) {
      reject("invalid-input", "internal-validation releaseTag must be null");
    }
    return;
  }
  if (target.releaseTag === null) {
    reject("invalid-input", "tag operation requires releaseTag");
  }
}

function validateOperationShape(operation, execution) {
  const expectedWorkflow = {
    "tag-preflight": ".github/workflows/openclaw-npm-release.yml",
    "sha-preflight": ".github/workflows/openclaw-npm-release.yml",
    "internal-validation": ".github/workflows/full-release-validation.yml",
    publish: ".github/workflows/openclaw-release-publish.yml",
    postpublish: ".github/workflows/openclaw-release-publish.yml",
    "stable-closeout": ".github/workflows/openclaw-stable-main-closeout.yml",
  }[operation];
  const eventAllowed =
    operation === "stable-closeout"
      ? execution.event === "push" || execution.event === "workflow_dispatch"
      : execution.event === "workflow_dispatch";
  if (execution.workflowPath !== expectedWorkflow || !eventAllowed) {
    reject("operation-not-allowed", "operation workflow or event is not allowed");
  }
  if (
    (operation === "sha-preflight" || operation === "stable-closeout") &&
    execution.executionRef !== POLICY_MAIN_REF
  ) {
    reject("execution-not-authorized", "operation execution ref is not authorized");
  }
}

function validateExecutionEnvironment(execution) {
  const expectedWorkflowRef = `${REPOSITORY}/${execution.workflowPath}@${execution.executionRef}`;
  const expected = {
    GITHUB_EVENT_NAME: execution.event,
    GITHUB_WORKFLOW_REF: expectedWorkflowRef,
    GITHUB_REF: execution.executionRef,
    GITHUB_SHA: execution.runHeadSha,
    GITHUB_RUN_ID: execution.runId,
    GITHUB_RUN_ATTEMPT: execution.runAttempt,
  };
  if (Object.entries(expected).some(([key, value]) => process.env[key] !== value)) {
    reject("execution-not-authorized", "authenticated workflow execution does not match input");
  }
}

function safeGitEnvironment() {
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (key.startsWith("GIT_") || key === "SSH_ASKPASS" || key === "GCM_INTERACTIVE") {
      delete environment[key];
    }
  }
  return {
    ...environment,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "never",
    GIT_ASKPASS: "/bin/false",
    SSH_ASKPASS: "/bin/false",
  };
}

function git(repository, args, failureCode, failureReason, { allowFailure = false } = {}) {
  const result = spawnSync(
    "git",
    [
      "--no-pager",
      "-c",
      "credential.helper=",
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "submodule.recurse=false",
      "-c",
      "protocol.file.allow=never",
      "-C",
      repository,
      ...args,
    ],
    {
      encoding: "buffer",
      env: safeGitEnvironment(),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (result.status !== 0) {
    if (allowFailure) {
      return null;
    }
    reject(failureCode, failureReason);
  }
  return result.stdout;
}

function initializeBare(prefix, failureCode, failureReason) {
  const directory = mkdtempSync(path.join(tmpdir(), prefix));
  try {
    git(directory, ["init", "--quiet", "--bare"], failureCode, failureReason);
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
  return directory;
}

function authenticatePolicySource(policyRoot, expectedSha) {
  const authenticationRepo = initializeBare(
    "openclaw-release-policy-",
    "canonical-fetch-failed",
    "canonical policy fetch failed",
  );
  try {
    git(
      authenticationRepo,
      [
        "fetch",
        "--quiet",
        "--no-tags",
        "--no-recurse-submodules",
        CANONICAL_FETCH_URL,
        `+${POLICY_MAIN_REF}:refs/verify/policy-main`,
      ],
      "canonical-fetch-failed",
      "canonical policy fetch failed",
    );
    const canonicalSha = git(
      authenticationRepo,
      ["rev-parse", "refs/verify/policy-main^{commit}"],
      "canonical-fetch-failed",
      "canonical policy ref could not be resolved",
    )
      .toString("utf8")
      .trim();
    if (canonicalSha !== expectedSha) {
      reject("policy-source-mismatch", "expected policy SHA is not canonical main tip");
    }
    verifyPolicyCheckout(policyRoot, canonicalSha, authenticationRepo);
    const blobs = readPolicyBlobs(authenticationRepo, canonicalSha);
    return { authenticationRepo, canonicalSha, blobs };
  } catch (error) {
    rmSync(authenticationRepo, { recursive: true, force: true });
    throw error;
  }
}

function verifyPolicyCheckout(policyRoot, canonicalSha, authenticationRepo) {
  let root;
  try {
    root = realpathSync(policyRoot);
  } catch {
    reject("policy-checkout-mismatch", "policy root is unavailable");
  }
  const head = git(
    root,
    ["rev-parse", "HEAD^{commit}"],
    "policy-checkout-mismatch",
    "policy checkout HEAD is unavailable",
  )
    .toString("utf8")
    .trim();
  const origin = git(
    root,
    ["remote", "get-url", "origin"],
    "policy-checkout-mismatch",
    "policy checkout origin is unavailable",
  )
    .toString("utf8")
    .trim();
  const status = git(
    root,
    ["status", "--porcelain=v1", "--untracked-files=all"],
    "policy-checkout-mismatch",
    "policy checkout cleanliness could not be verified",
  );
  if (head !== canonicalSha || origin !== CANONICAL_FETCH_URL || status.length !== 0) {
    reject("policy-checkout-mismatch", "policy checkout is not clean canonical main");
  }

  const expectedVerifier = path.join(root, POLICY_PATHS.verifier);
  try {
    if (
      !lstatSync(expectedVerifier).isFile() ||
      realpathSync(process.argv[1]) !== realpathSync(expectedVerifier)
    ) {
      reject("policy-checkout-mismatch", "verifier is not executing from policy root");
    }
  } catch (error) {
    if (error instanceof VerificationError) {
      throw error;
    }
    reject("policy-checkout-mismatch", "verifier is not executing from policy root");
  }

  for (const relativePath of [
    POLICY_PATHS.npmPublishPlan,
    POLICY_PATHS.releaseVersionPolicy,
    POLICY_PATHS.stableReleaseLines,
    POLICY_PATHS.releasePolicyEvidence,
    POLICY_PATHS.verifier,
  ]) {
    const absolutePath = path.join(root, relativePath);
    let localBytes;
    try {
      if (!lstatSync(absolutePath).isFile()) {
        reject("policy-checkout-mismatch", "policy module is not a regular file");
      }
      localBytes = readFileSync(absolutePath);
    } catch (error) {
      if (error instanceof VerificationError) {
        throw error;
      }
      reject("policy-checkout-mismatch", "policy module is unavailable");
    }
    const canonicalBytes = showBlob(authenticationRepo, canonicalSha, relativePath, false);
    if (!localBytes.equals(canonicalBytes)) {
      reject("policy-checkout-mismatch", "policy module differs from authenticated source");
    }
  }
}

function showBlob(repository, sha, relativePath, optional) {
  const bytes = git(
    repository,
    ["show", `${sha}:${relativePath}`],
    "policy-source-mismatch",
    "authenticated policy blob is unavailable",
    { allowFailure: optional },
  );
  if (bytes === null && !optional) {
    reject("policy-source-mismatch", "authenticated policy blob is unavailable");
  }
  return bytes;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function readPolicyBlobs(repository, sha) {
  const releaseVersionPolicy = showBlob(repository, sha, POLICY_PATHS.releaseVersionPolicy, false);
  const stableReleaseLines = showBlob(repository, sha, POLICY_PATHS.stableReleaseLines, false);
  const verifier = showBlob(repository, sha, POLICY_PATHS.verifier, false);
  const stableLines = showBlob(repository, sha, POLICY_PATHS.stableLines, true);
  return {
    releaseVersionPolicy,
    stableReleaseLines,
    verifier,
    stableLines,
  };
}

async function loadPolicyModules(policyRoot, sha) {
  const suffix = `?policy=${sha}`;
  return {
    plan: await import(
      `${pathToFileURL(path.join(policyRoot, POLICY_PATHS.npmPublishPlan)).href}${suffix}`
    ),
    version: await import(
      `${pathToFileURL(path.join(policyRoot, POLICY_PATHS.releaseVersionPolicy)).href}${suffix}`
    ),
    stable: await import(
      `${pathToFileURL(path.join(policyRoot, POLICY_PATHS.stableReleaseLines)).href}${suffix}`
    ),
    evidence: await import(
      `${pathToFileURL(path.join(policyRoot, POLICY_PATHS.releasePolicyEvidence)).href}${suffix}`
    ),
  };
}

async function classifyRelease(input, modules) {
  if (input.policyMode === "strict") {
    try {
      return modules.version.validateStrictPublishPolicy({
        version: input.releaseVersion,
        releaseSelector: input.releaseSelector,
      });
    } catch {
      reject("selector-mismatch", "release version and selector do not match strict policy");
    }
  }
  const parsedVersion = modules.plan.parseReleaseVersion(input.releaseVersion);
  if (parsedVersion === null) {
    reject("selector-mismatch", "release version is unsupported");
  }
  return { parsedVersion, releaseClass: parsedVersion.releaseClass };
}

function stableMetadata(input, classification, modules, blobs) {
  const isStable =
    classification.releaseClass === "stable-base" || classification.releaseClass === "stable-patch";
  if (!isStable) {
    return { metadata: null, digest: null };
  }
  if (blobs.stableLines === null) {
    reject("metadata-invalid", "stable release metadata is unavailable");
  }
  let metadata;
  try {
    metadata = JSON.parse(blobs.stableLines.toString("utf8"));
    modules.stable.validateStableReleaseLines(metadata);
    if (
      modules.stable.serializeStableReleaseLines(metadata) !== blobs.stableLines.toString("utf8")
    ) {
      reject("metadata-invalid", "stable release metadata is not canonical");
    }
  } catch (error) {
    if (error instanceof VerificationError) {
      throw error;
    }
    reject("metadata-invalid", "stable release metadata is invalid");
  }
  return { metadata, digest: sha256(blobs.stableLines) };
}

function expectedSourceRef(input, parsedVersion, releaseClass, metadata) {
  const actual = input.target.authorizedSourceRef;
  if (input.operation === "sha-preflight") {
    return null;
  }
  let allowed = [];
  if (releaseClass === "alpha") {
    allowed = ALPHA_REF_PATTERN.test(actual ?? "") ? [actual] : [];
  } else if (releaseClass === "beta") {
    allowed = [POLICY_MAIN_REF, `refs/heads/release/${parsedVersion.baseVersion}`];
  } else if (releaseClass === "daily") {
    allowed = [POLICY_MAIN_REF, `refs/heads/release/${input.releaseVersion}`];
  } else if (releaseClass === "historical-correction" && input.policyMode === "legacy") {
    allowed = [POLICY_MAIN_REF, `refs/heads/release/${parsedVersion.baseVersion}`];
  } else if (releaseClass === "stable-base" || releaseClass === "stable-patch") {
    const line = metadata.lines.find((candidate) => {
      if (candidate.month !== `${parsedVersion.year}.${parsedVersion.month}`) {
        return false;
      }
      if (releaseClass === "stable-base") {
        return (
          candidate.baseVersion === input.releaseVersion &&
          (candidate.status === "planned" || candidate.status === "active")
        );
      }
      return candidate.status === "active";
    });
    allowed = line === undefined ? [] : [`refs/heads/${line.branch}`];
  }
  if (!allowed.includes(actual)) {
    reject("target-not-authorized", "authorized source ref is not allowed for release class");
  }
  return actual;
}

function enforceRefMatrix(input, authorizedSourceRef) {
  const { operation, releaseVersion, execution, target } = input;
  if (["tag-preflight", "publish", "postpublish"].includes(operation)) {
    if (
      target.targetRef !== `refs/tags/v${releaseVersion}` ||
      target.releaseTag !== `v${releaseVersion}` ||
      execution.executionRef !== authorizedSourceRef
    ) {
      reject("target-not-authorized", "tag operation refs do not match release authority");
    }
  } else if (operation === "internal-validation") {
    if (
      target.targetRef !== authorizedSourceRef ||
      execution.executionRef !== authorizedSourceRef
    ) {
      reject("target-not-authorized", "validation refs do not match release authority");
    }
  } else if (operation === "stable-closeout") {
    if (
      target.targetRef !== `refs/tags/v${releaseVersion}` ||
      target.releaseTag !== `v${releaseVersion}`
    ) {
      reject("target-not-authorized", "closeout tag does not match release version");
    }
  }
}

function observeTarget(input, authorizedSourceRef) {
  const repository = initializeBare(
    "openclaw-release-target-",
    "canonical-fetch-failed",
    "canonical target fetch setup failed",
  );
  try {
    const refspecs =
      input.operation === "sha-preflight"
        ? [`+${POLICY_MAIN_REF}:refs/verify/target`]
        : [
            `+${input.target.targetRef}:refs/verify/target`,
            `+${authorizedSourceRef}:refs/verify/source`,
          ];
    git(
      repository,
      [
        "fetch",
        "--quiet",
        "--no-tags",
        "--no-recurse-submodules",
        CANONICAL_FETCH_URL,
        ...refspecs,
      ],
      "target-unavailable",
      "required canonical target refs are unavailable",
    );
    const targetSha = git(
      repository,
      ["rev-parse", "refs/verify/target^{commit}"],
      "target-unavailable",
      "canonical target could not be resolved",
    )
      .toString("utf8")
      .trim();
    if (targetSha !== input.target.targetSha) {
      reject("target-not-authorized", "target SHA does not match canonical ref");
    }
    if (input.operation === "sha-preflight") {
      return {
        targetRef: null,
        targetSha,
        releaseTag: null,
        authorizedSourceRef: null,
        authorizedSourceTipSha: null,
        targetReachableFromAuthorizedSource: null,
      };
    }
    const sourceTip = git(
      repository,
      ["rev-parse", "refs/verify/source^{commit}"],
      "target-unavailable",
      "canonical authorized source could not be resolved",
    )
      .toString("utf8")
      .trim();
    const reachable =
      git(
        repository,
        ["merge-base", "--is-ancestor", targetSha, sourceTip],
        "target-not-reachable",
        "release target is not reachable from authorized source",
        { allowFailure: true },
      ) !== null;
    if (!reachable) {
      reject("target-not-reachable", "release target is not reachable from authorized source");
    }
    return {
      targetRef: input.target.targetRef,
      targetSha,
      releaseTag: input.target.releaseTag,
      authorizedSourceRef,
      authorizedSourceTipSha: sourceTip,
      targetReachableFromAuthorizedSource: true,
    };
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
}

function enforceExecutionTip(input, target, policySha, releaseClass) {
  const expectedHead =
    input.operation === "sha-preflight" || input.operation === "stable-closeout"
      ? policySha
      : target.authorizedSourceTipSha;
  if (input.execution.runHeadSha !== expectedHead) {
    reject("execution-not-authorized", "workflow head does not match authenticated execution ref");
  }
  if (input.operation === "stable-closeout") {
    if (
      input.releaseSelector !== "stable" ||
      !["stable-base", "stable-patch"].includes(releaseClass)
    ) {
      reject("operation-not-allowed", "stable closeout requires a stable release");
    }
  }
}

async function verify(options) {
  const input = readInput(options.inputPath);
  if (process.env.GITHUB_REPOSITORY !== REPOSITORY) {
    reject("repository-identity-mismatch", "GITHUB_REPOSITORY must be openclaw/openclaw");
  }
  validateExecutionEnvironment(input.execution);

  const authenticated = authenticatePolicySource(options.policyRoot, input.expectedPolicySourceSha);
  try {
    const modules = await loadPolicyModules(options.policyRoot, authenticated.canonicalSha);
    const classification = await classifyRelease(input, modules);
    const stable = stableMetadata(input, classification, modules, authenticated.blobs);
    const authorizedSourceRef = expectedSourceRef(
      input,
      classification.parsedVersion,
      classification.releaseClass,
      stable.metadata,
    );
    enforceRefMatrix(input, authorizedSourceRef);
    const target = observeTarget(input, authorizedSourceRef);
    enforceExecutionTip(input, target, authenticated.canonicalSha, classification.releaseClass);

    const policySource = {
      sha: authenticated.canonicalSha,
      blobs: {
        releaseVersionPolicySha256: sha256(authenticated.blobs.releaseVersionPolicy),
        stableReleaseLinesModuleSha256: sha256(authenticated.blobs.stableReleaseLines),
        verifyReleaseOperationSha256: sha256(authenticated.blobs.verifier),
        stableLinesSha256: stable.digest,
      },
    };
    try {
      modules.evidence.validateReleasePolicy({
        version: 1,
        releaseVersion: input.releaseVersion,
        releaseClass: classification.releaseClass,
        releaseSelector: input.releaseSelector,
        policyMode: input.policyMode,
        publishEligible: !(
          input.policyMode === "strict" &&
          ["stable-base", "stable-patch"].includes(classification.releaseClass)
        ),
        authorizedSourceRef,
        policySource,
      });
    } catch {
      reject("metadata-invalid", "constructed release policy is invalid");
    }
    return {
      schemaVersion: 1,
      ok: true,
      operation: input.operation,
      releaseVersion: input.releaseVersion,
      releaseClass: classification.releaseClass,
      releaseSelector: input.releaseSelector,
      policyMode: input.policyMode,
      policySource,
      execution: input.execution,
      target,
    };
  } finally {
    rmSync(authenticated.authenticationRepo, { recursive: true, force: true });
  }
}

function writeJson(stream, value) {
  stream.write(`${JSON.stringify(value)}\n`);
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === "contract") {
    if (args.length !== 1 || args[0] !== "--json") {
      reject("invalid-arguments", "contract accepts only --json");
    }
    writeJson(process.stdout, {
      schemaVersion: 1,
      supportedContractVersions: [1],
      repository: REPOSITORY,
      canonicalFetchUrl: CANONICAL_FETCH_URL,
    });
    return;
  }
  if (command !== "verify") {
    reject("invalid-arguments", "command must be contract or verify");
  }
  const options = parseVerifyArguments(args);
  writeJson(process.stdout, await verify(options));
}

try {
  await main();
} catch (error) {
  const known = error instanceof VerificationError;
  const code = known && EXIT_BY_ERROR.has(error.code) ? error.code : "internal-error";
  const reason = known ? error.message : "unexpected verifier failure";
  writeJson(process.stderr, {
    schemaVersion: CONTRACT_VERSION,
    ok: false,
    error: { code, reason },
  });
  process.exitCode = EXIT_BY_ERROR.get(code) ?? 70;
}
