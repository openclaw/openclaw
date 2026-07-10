import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { t as listTar, x as extractTar } from "tar";
import { renderGithubReleaseNotes } from "../render-github-release-notes.mjs";

const KIND = "openclaw.release-delta-evidence";
const MODE = "release-delta-reuse-v3";
const SHA_RE = /^[0-9a-f]{40}$/u;
const SHA256_RE = /^[0-9a-f]{64}$/u;
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/u;
const BETA_VERSION_RE = /^\d{4}\.\d+\.\d+-beta\.\d+$/u;
const STABLE_RELEASE_TAG_RE = /^v\d{4}\.[1-9]\d*\.[1-9]\d*$/u;
const POLICY_PATH_RE = /^\.github\/release-delta-policies\/[A-Za-z0-9][A-Za-z0-9._-]*\.json$/u;
const SAFE_PATH_RE = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*\\).+$/u;
const RELEASE_METADATA_PATH_RE =
  /^(?:CHANGELOG\.md|docs\/(?:ci\.md|reference\/(?:RELEASING|full-release-validation)\.md))$/u;
const EXPECTED_TOKENS = new Set(["baseline", "source", "parent", "target"]);
const ROLE_MODES = new Set(["reused", "fresh"]);
const PRODUCER_JOB_NAMES = [
  "target-tooling",
  "target-container",
  "target-provider-preflight",
  "focused-openwebui",
];
const PRODUCER_JOBS = new Set(PRODUCER_JOB_NAMES);
const RUN_CONCLUSIONS = new Set(["success", "cancelled"]);
const ASSERTION_OPERATORS = new Set(["eq", "matches", "length", "includes", "all-eq", "sha256"]);
const PRODUCER_WORKFLOW = ".github/workflows/release-delta-evidence.yml";
const NPM_PREFLIGHT_WORKFLOW = ".github/workflows/openclaw-npm-release.yml";
const TELEGRAM_PACKAGE_WORKFLOW = ".github/workflows/npm-telegram-beta-e2e.yml";
const PRODUCER_JOB_CONTRACTS = {
  "target-tooling": {
    job: "Target release tooling",
    artifact: {
      key: "tooling",
      name: "release-delta-tooling-{runId}-{runAttempt}",
      files: [{ path: "tooling-check-evidence.json" }],
    },
    report: {
      artifactKey: "tooling",
      path: "tooling-check-evidence.json",
      format: "json",
      assertions: [
        { pointer: "/schemaVersion", op: "eq", value: 1 },
        { pointer: "/sourceSha", op: "eq", value: "$sourceSha" },
        { pointer: "/parentSha", op: "eq", value: "$parentSha" },
        { pointer: "/targetSha", op: "eq", value: "$targetSha" },
        { pointer: "/conclusion", op: "eq", value: "success" },
      ],
    },
    binding: {
      type: "artifact-json",
      artifactKey: "tooling",
      path: "tooling-check-evidence.json",
      pointer: "/targetSha",
      expected: "target",
    },
  },
  "target-container": {
    job: "Target release container",
    artifact: {
      key: "container",
      name: "release-delta-container-{runId}-{runAttempt}",
      files: [{ path: "container-build-evidence.json" }],
    },
    report: {
      artifactKey: "container",
      path: "container-build-evidence.json",
      format: "json",
      assertions: [
        {
          pointer: "/schema",
          op: "eq",
          value: "openclaw.release-delta-container-evidence/v1",
        },
        { pointer: "/schemaVersion", op: "eq", value: 1 },
        { pointer: "/workflowPath", op: "eq", value: PRODUCER_WORKFLOW },
        { pointer: "/targetSha", op: "eq", value: "$targetSha" },
        { pointer: "/context/revision", op: "eq", value: "$targetSha" },
        { pointer: "/conclusion", op: "eq", value: "success" },
      ],
    },
    binding: {
      type: "artifact-json",
      artifactKey: "container",
      path: "container-build-evidence.json",
      pointer: "/targetSha",
      expected: "target",
    },
  },
  "target-provider-preflight": {
    job: "Target provider secret preflight",
    artifact: {
      key: "provider",
      name: "release-delta-provider-{runId}-{runAttempt}",
      files: [{ path: "provider-secret-preflight.json" }],
    },
    report: {
      artifactKey: "provider",
      path: "provider-secret-preflight.json",
      format: "json",
      assertions: [
        {
          pointer: "/schema",
          op: "eq",
          value: "openclaw.release-delta-provider-preflight/v1",
        },
        { pointer: "/schemaVersion", op: "eq", value: 1 },
        { pointer: "/workflowPath", op: "eq", value: PRODUCER_WORKFLOW },
        { pointer: "/targetSha", op: "eq", value: "$targetSha" },
        { pointer: "/required", op: "length", value: 3 },
        { pointer: "/results", op: "length", value: 3 },
        { pointer: "/results/*/status", op: "all-eq", value: "ok" },
        { pointer: "/results/*/required", op: "all-eq", value: true },
        { pointer: "/conclusion", op: "eq", value: "success" },
      ],
    },
    binding: {
      type: "artifact-json",
      artifactKey: "provider",
      path: "provider-secret-preflight.json",
      pointer: "/targetSha",
      expected: "target",
    },
  },
  "focused-openwebui": {
    job: "Focused exact-target OpenWebUI package acceptance / Focused exact-target OpenWebUI package acceptance / Docker E2E (openwebui)",
    artifact: {
      key: "openwebui",
      name: "openwebui-exact-target-evidence",
      files: [{ path: "openwebui-exact-target-evidence.json" }],
    },
    report: {
      artifactKey: "openwebui",
      path: "openwebui-exact-target-evidence.json",
      format: "json",
      assertions: [
        {
          pointer: "/schema",
          op: "eq",
          value: "openclaw.openwebui-exact-target-evidence/v1",
        },
        { pointer: "/targetSha", op: "eq", value: "$targetSha" },
        { pointer: "/packages/root/name", op: "eq", value: "openclaw" },
        { pointer: "/packages/root/version", op: "eq", value: "$version" },
        { pointer: "/scenario/id", op: "eq", value: "openwebui-chat" },
        { pointer: "/scenario/provider", op: "eq", value: "openai" },
        { pointer: "/mutations/sharedGhcrLogin", op: "eq", value: false },
        { pointer: "/mutations/sharedImagePull", op: "eq", value: false },
        { pointer: "/mutations/candidateImagePull", op: "eq", value: false },
        { pointer: "/mutations/imagePush", op: "eq", value: false },
        { pointer: "/image/localImageRequired", op: "eq", value: true },
        { pointer: "/result/conclusion", op: "eq", value: "success" },
      ],
    },
    binding: {
      type: "artifact-json",
      artifactKey: "openwebui",
      path: "openwebui-exact-target-evidence.json",
      pointer: "/targetSha",
      expected: "target",
    },
  },
};

function fail(message) {
  throw new Error(`Release delta evidence: ${message}`);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const git = (cwd, args, encoding = "utf8") =>
  execFileSync("git", args, { cwd, encoding, maxBuffer: 128 * 1024 * 1024 });

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .toSorted()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function parseJson(raw, label) {
  try {
    return typeof raw === "string" || Buffer.isBuffer(raw) ? JSON.parse(raw.toString()) : raw;
  } catch {
    fail(`${label} is not valid JSON`);
  }
}

function exactObject(value, required, optional, label) {
  assert(value && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  const allowed = new Set([...required, ...optional]);
  assert(
    required.every((key) => Object.hasOwn(value, key)),
    `${label} is missing required fields`,
  );
  assert(
    Object.keys(value).every((key) => allowed.has(key)),
    `${label} contains unsupported fields`,
  );
  return value;
}

function uniqueStrings(value, label, { allowEmpty = false } = {}) {
  assert(Array.isArray(value), `${label} must be an array`);
  assert(allowEmpty || value.length > 0, `${label} must not be empty`);
  assert(
    value.every((entry) => typeof entry === "string" && entry.length > 0),
    `${label} must contain strings`,
  );
  assert(new Set(value).size === value.length, `${label} contains duplicates`);
  return value;
}

function validPath(value, label) {
  assert(typeof value === "string" && SAFE_PATH_RE.test(value), `${label} is unsafe`);
  return value;
}

function validSha(value, label) {
  assert(typeof value === "string" && SHA_RE.test(value), `${label} is not a lowercase Git SHA`);
  return value;
}

function validSha256(value, label) {
  assert(typeof value === "string" && SHA256_RE.test(value), `${label} is not SHA-256`);
  return value;
}

function validDigest(value, label) {
  assert(typeof value === "string" && DIGEST_RE.test(value), `${label} is not a SHA-256 digest`);
  return value;
}

export function validateReleaseDeltaPolicyPath(value) {
  assert(
    typeof value === "string" && POLICY_PATH_RE.test(value),
    "release delta policy path is unsafe",
  );
  return value;
}

export function parsePositiveDecimalId(value, label = "id") {
  const text = typeof value === "number" ? String(value) : value;
  assert(typeof text === "string" && /^[1-9]\d*$/u.test(text), `${label} is invalid`);
  const number = Number(text);
  assert(Number.isSafeInteger(number) && number > 0, `${label} is unsafe`);
  return number;
}

export function validateArtifactInventory(entries, expectedPaths, label = "artifact") {
  assert(Array.isArray(entries), `${label} inventory must be an array`);
  const expected = uniqueStrings(expectedPaths, `${label} expected files`, { allowEmpty: true });
  const rawEntries = new Set();
  const normalizedEntries = new Set();
  const files = [];
  const directories = [];
  for (const [index, entry] of entries.entries()) {
    assert(typeof entry === "string" && entry.length > 0, `${label} entry ${index} is invalid`);
    assert(!rawEntries.has(entry), `${label} inventory contains duplicate entries`);
    rawEntries.add(entry);
    const directory = entry.endsWith("/");
    const normalized = directory ? entry.replace(/\/+$/u, "") : entry;
    assert(
      normalized.length > 0 && SAFE_PATH_RE.test(normalized) && !path.posix.isAbsolute(normalized),
      `${label} inventory contains an unsafe entry`,
    );
    assert(
      !normalizedEntries.has(normalized),
      `${label} inventory contains duplicate normalized entries`,
    );
    normalizedEntries.add(normalized);
    if (directory) directories.push(normalized);
    else files.push(normalized);
  }
  assert(new Set(files).size === files.length, `${label} inventory contains duplicate files`);
  assert(
    directories.every((directory) =>
      expected.some((filePath) => filePath.startsWith(`${directory}/`)),
    ),
    `${label} inventory contains an undeclared directory`,
  );
  assert(
    JSON.stringify(files.toSorted()) === JSON.stringify([...expected].toSorted()),
    `${label} inventory differs from its file contract`,
  );
  return files.toSorted();
}

function parseAssertion(value, label) {
  exactObject(value, ["pointer", "op", "value"], [], label);
  assert(
    typeof value.pointer === "string" && value.pointer.startsWith("/"),
    `${label}.pointer is invalid`,
  );
  assert(ASSERTION_OPERATORS.has(value.op), `${label}.op is unsupported`);
  if (value.op === "matches") {
    assert(typeof value.value === "string", `${label}.value must be a pattern string`);
  }
  if (value.op === "length") {
    assert(
      Number.isSafeInteger(value.value) && value.value >= 0,
      `${label}.value must be a length`,
    );
  }
  return value;
}

function parseArtifact(value, label) {
  exactObject(value, ["key", "name", "files"], [], label);
  assert(/^[a-z][a-z0-9-]*$/u.test(value.key), `${label}.key is invalid`);
  assert(typeof value.name === "string" && value.name.length > 0, `${label}.name is invalid`);
  assert(Array.isArray(value.files), `${label}.files must be an array`);
  const filePaths = new Set();
  for (const [index, file] of value.files.entries()) {
    exactObject(file, ["path"], ["sha256"], `${label}.files[${index}]`);
    validPath(file.path, `${label}.files[${index}].path`);
    assert(!filePaths.has(file.path), `${label}.files contains duplicate paths`);
    filePaths.add(file.path);
    if (file.sha256 !== undefined) validSha256(file.sha256, `${label}.files[${index}].sha256`);
  }
  return value;
}

function parseBinding(value, artifactKeys, label) {
  assert(value && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  assert(["job-log", "run-head", "artifact-json"].includes(value.type), `${label}.type is invalid`);
  if (value.type === "job-log") {
    exactObject(value, ["type", "marker", "expected"], ["prefix"], label);
    assert(
      typeof value.marker === "string" && value.marker.length > 0,
      `${label}.marker is invalid`,
    );
    assert(
      value.prefix === undefined || typeof value.prefix === "string",
      `${label}.prefix is invalid`,
    );
  } else if (value.type === "run-head") {
    exactObject(value, ["type", "expected"], [], label);
  } else {
    exactObject(value, ["type", "artifactKey", "path", "pointer", "expected"], [], label);
    assert(artifactKeys.has(value.artifactKey), `${label}.artifactKey is unknown`);
    validPath(value.path, `${label}.path`);
    assert(
      typeof value.pointer === "string" && value.pointer.startsWith("/"),
      `${label}.pointer is invalid`,
    );
  }
  assert(EXPECTED_TOKENS.has(value.expected), `${label}.expected is invalid`);
  return value;
}

function parseRole(value, inputs, index) {
  const label = `policy.roles[${index}]`;
  exactObject(
    value,
    ["id", "gate", "input", "mode", "workflow", "impactPatterns", "run", "job", "binding"],
    ["producerJob", "artifacts", "reports", "logAssertions"],
    label,
  );
  assert(/^[a-z][a-z0-9-]*$/u.test(value.id), `${label}.id is invalid`);
  assert(/^[a-z][a-z0-9-]*$/u.test(value.gate), `${label}.gate is invalid`);
  assert(value.input === "producer" || inputs.has(value.input), `${label}.input is unknown`);
  assert(ROLE_MODES.has(value.mode), `${label}.mode is invalid`);
  assert(
    value.input === "producer"
      ? value.mode === "fresh" && PRODUCER_JOBS.has(value.producerJob)
      : value.producerJob === undefined,
    `${label}.producerJob is invalid`,
  );
  validPath(value.workflow, `${label}.workflow`);
  assert(
    value.input === "producer" || value.workflow !== ".github/workflows/release-delta-evidence.yml",
    `${label} must not chain release delta evidence`,
  );
  uniqueStrings(value.impactPatterns, `${label}.impactPatterns`, { allowEmpty: true });
  assert(
    value.impactPatterns.every((pattern) => {
      try {
        new RegExp(pattern, "u");
        return true;
      } catch {
        return false;
      }
    }),
    `${label}.impactPatterns contains an invalid pattern`,
  );
  assert(
    value.mode === "fresh" || value.impactPatterns.length > 0,
    `${label}.impactPatterns must guard reused evidence`,
  );

  exactObject(value.run, ["event", "headBranch", "attempt", "conclusions"], [], `${label}.run`);
  assert(
    typeof value.run.event === "string" && value.run.event.length > 0,
    `${label}.run.event is invalid`,
  );
  assert(
    typeof value.run.headBranch === "string" && value.run.headBranch.length > 0,
    `${label}.run.headBranch is invalid`,
  );
  assert(value.run.attempt === 1, `${label}.run.attempt must be 1`);
  uniqueStrings(value.run.conclusions, `${label}.run.conclusions`);
  assert(
    value.run.conclusions.every((entry) => RUN_CONCLUSIONS.has(entry)),
    `${label}.run.conclusions is invalid`,
  );

  exactObject(value.job, ["name", "conclusion"], [], `${label}.job`);
  assert(
    typeof value.job.name === "string" && value.job.name.length > 0,
    `${label}.job.name is invalid`,
  );
  assert(value.job.conclusion === "success", `${label}.job.conclusion must be success`);

  const artifacts = value.artifacts ?? [];
  assert(Array.isArray(artifacts), `${label}.artifacts must be an array`);
  const artifactKeys = new Set();
  for (const [artifactIndex, artifact] of artifacts.entries()) {
    parseArtifact(artifact, `${label}.artifacts[${artifactIndex}]`);
    assert(
      value.input === "producer" ||
        artifact.files.every(
          (file) => path.posix.basename(file.path) !== "release-delta-evidence.json",
        ),
      `${label} must not consume release delta evidence`,
    );
    assert(!artifactKeys.has(artifact.key), `${label}.artifacts contains duplicate keys`);
    artifactKeys.add(artifact.key);
  }
  parseBinding(value.binding, artifactKeys, `${label}.binding`);
  assert(
    (value.mode === "reused" && value.binding.expected === "source") ||
      (value.mode === "fresh" && ["parent", "target"].includes(value.binding.expected)),
    `${label}.binding.expected is incompatible with ${value.mode} evidence`,
  );

  const reports = value.reports ?? [];
  assert(Array.isArray(reports), `${label}.reports must be an array`);
  for (const [reportIndex, report] of reports.entries()) {
    const reportLabel = `${label}.reports[${reportIndex}]`;
    exactObject(report, ["artifactKey", "path", "format", "assertions"], [], reportLabel);
    assert(artifactKeys.has(report.artifactKey), `${reportLabel}.artifactKey is unknown`);
    validPath(report.path, `${reportLabel}.path`);
    assert(report.format === "json", `${reportLabel}.format must be json`);
    assert(
      Array.isArray(report.assertions) && report.assertions.length > 0,
      `${reportLabel}.assertions is empty`,
    );
    report.assertions.forEach((assertion, assertionIndex) =>
      parseAssertion(assertion, `${reportLabel}.assertions[${assertionIndex}]`),
    );
  }

  const logAssertions = value.logAssertions ?? [];
  assert(Array.isArray(logAssertions), `${label}.logAssertions must be an array`);
  for (const [logIndex, entry] of logAssertions.entries()) {
    const logLabel = `${label}.logAssertions[${logIndex}]`;
    exactObject(entry, ["jobName", "pattern", "count"], [], logLabel);
    assert(
      typeof entry.jobName === "string" && entry.jobName.length > 0,
      `${logLabel}.jobName is invalid`,
    );
    assert(
      typeof entry.pattern === "string" && entry.pattern.length > 0,
      `${logLabel}.pattern is invalid`,
    );
    assert(Number.isSafeInteger(entry.count) && entry.count > 0, `${logLabel}.count is invalid`);
  }
  return value;
}

function validateProducerRoleContract(role, label) {
  const contract = PRODUCER_JOB_CONTRACTS[role.producerJob];
  assert(contract, `${label}.producerJob is unsupported`);
  assert(
    role.workflow === PRODUCER_WORKFLOW &&
      role.run.event === "workflow_dispatch" &&
      role.run.headBranch === "main" &&
      role.run.attempt === 1 &&
      stableJson(role.run.conclusions) === stableJson(["success"]) &&
      role.job.name === contract.job &&
      role.job.conclusion === "success",
    `${label} producer provenance differs from ${role.producerJob}`,
  );
  assert(
    stableJson(role.artifacts ?? []) === stableJson([contract.artifact]) &&
      stableJson(role.reports ?? []) === stableJson([contract.report]) &&
      stableJson(role.binding) === stableJson(contract.binding) &&
      stableJson(role.logAssertions ?? []) === stableJson([]),
    `${label} producer evidence contract differs from ${role.producerJob}`,
  );
}

function npmPreflightArtifactFiles(version) {
  return [
    { path: "ai-runtime-SHA256SUMS" },
    { path: "dependency-evidence/dependency-changes-report.md" },
    { path: "dependency-evidence/dependency-changes-report.json" },
    { path: "dependency-evidence/dependency-evidence-manifest.json" },
    { path: "dependency-evidence/dependency-evidence-summary.md" },
    { path: "dependency-evidence/dependency-ownership-surface-report.json" },
    { path: "dependency-evidence/dependency-ownership-surface-report.md" },
    { path: "dependency-evidence/dependency-vulnerability-gate.json" },
    { path: "dependency-evidence/dependency-vulnerability-gate.md" },
    { path: "dependency-evidence/transitive-manifest-risk-report.json" },
    { path: "dependency-evidence/transitive-manifest-risk-report.md" },
    { path: `openclaw-${version}.tgz` },
    { path: `openclaw-ai-${version}.tgz` },
    { path: "preflight-manifest.json" },
    { path: "release-npm-dist-tag.txt" },
    { path: "release-sha.txt" },
    { path: "release-tag.txt" },
  ];
}

function npmPackageRoleContract(policy, mode) {
  const expected = mode === "reused" ? "source" : "target";
  const expectedSha = mode === "reused" ? "$sourceSha" : "$targetSha";
  const artifactSha = mode === "reused" ? "{sourceSha}" : "{targetSha}";
  const version = policy.release.version;
  return {
    mode,
    workflow: NPM_PREFLIGHT_WORKFLOW,
    run: {
      event: "workflow_dispatch",
      headBranch: policy.release.targetRef,
      attempt: 1,
      conclusions: ["success"],
    },
    job: { name: "preflight_openclaw_npm", conclusion: "success" },
    artifacts: [
      {
        key: "npm-preflight",
        name: `openclaw-npm-preflight-${artifactSha}`,
        files: npmPreflightArtifactFiles(version),
      },
    ],
    reports: [
      {
        artifactKey: "npm-preflight",
        path: "preflight-manifest.json",
        format: "json",
        assertions: [
          { pointer: "/version", op: "eq", value: 1 },
          { pointer: "/releaseTag", op: "eq", value: policy.release.tag },
          { pointer: "/releaseSha", op: "eq", value: expectedSha },
          { pointer: "/npmDistTag", op: "eq", value: "beta" },
          { pointer: "/packageName", op: "eq", value: "openclaw" },
          { pointer: "/packageVersion", op: "eq", value: version },
          { pointer: "/tarballName", op: "eq", value: `openclaw-${version}.tgz` },
          { pointer: "/tarballSha256", op: "matches", value: "^[0-9a-f]{64}$" },
          { pointer: "/dependencyTarballs", op: "length", value: 1 },
          { pointer: "/dependencyTarballs/0/packageName", op: "eq", value: "@openclaw/ai" },
          { pointer: "/dependencyTarballs/0/packageVersion", op: "eq", value: version },
          {
            pointer: "/dependencyTarballs/0/tarballName",
            op: "eq",
            value: `openclaw-ai-${version}.tgz`,
          },
          {
            pointer: "/dependencyTarballs/0/tarballSha256",
            op: "matches",
            value: "^[0-9a-f]{64}$",
          },
          { pointer: "/dependencyEvidenceDir", op: "eq", value: "dependency-evidence" },
          {
            pointer: "/dependencyEvidenceManifest",
            op: "eq",
            value: "dependency-evidence/dependency-evidence-manifest.json",
          },
        ],
      },
    ],
    binding: { type: "run-head", expected },
    logAssertions: [],
  };
}

function telegramPackageRoleContract() {
  return {
    mode: "fresh",
    workflow: TELEGRAM_PACKAGE_WORKFLOW,
    run: {
      event: "workflow_dispatch",
      headBranch: "main",
      attempt: 1,
      conclusions: ["success"],
    },
    job: { name: "Run package Telegram E2E", conclusion: "success" },
    artifacts: [
      {
        key: "package-consumption",
        name: "npm-telegram-package-consumption-{runId}-{runAttempt}",
        files: [{ path: "package-consumption.json" }],
      },
    ],
    reports: [
      {
        artifactKey: "package-consumption",
        path: "package-consumption.json",
        format: "json",
        assertions: [
          { pointer: "/schemaVersion", op: "eq", value: 1 },
          { pointer: "/workflow/runAttempt", op: "eq", value: 1 },
          { pointer: "/workflow/path", op: "eq", value: TELEGRAM_PACKAGE_WORKFLOW },
          { pointer: "/targetSha", op: "eq", value: "$targetSha" },
          { pointer: "/packageVersion", op: "eq", value: "$version" },
          { pointer: "/packageArtifact/runId", op: "eq", value: "$targetNpmRunId" },
          { pointer: "/packageArtifact/id", op: "eq", value: "$targetNpmArtifactId" },
          {
            pointer: "/packageArtifact/name",
            op: "eq",
            value: "$targetNpmArtifactName",
          },
          {
            pointer: "/packageArtifact/digest",
            op: "eq",
            value: "$targetNpmArtifactDigest",
          },
          { pointer: "/packageArtifact/root/name", op: "eq", value: "$targetRootName" },
          {
            pointer: "/packageArtifact/root/sha256",
            op: "eq",
            value: "$targetRootSha256",
          },
          { pointer: "/packageArtifact/ai/name", op: "eq", value: "$targetAiName" },
          {
            pointer: "/packageArtifact/ai/sha256",
            op: "eq",
            value: "$targetAiSha256",
          },
          { pointer: "/qa/providerMode", op: "eq", value: "mock-openai" },
          { pointer: "/qa/scenario", op: "eq", value: "" },
          { pointer: "/qa/conclusion", op: "eq", value: "success" },
        ],
      },
    ],
    binding: {
      type: "artifact-json",
      artifactKey: "package-consumption",
      path: "package-consumption.json",
      pointer: "/targetSha",
      expected: "target",
    },
    logAssertions: [],
  };
}

function validatePackageRoleContract(role, contract, label) {
  assert(role.input !== "producer", `${label} must not be a producer role`);
  const actual = {
    mode: role.mode,
    workflow: role.workflow,
    run: role.run,
    job: role.job,
    artifacts: role.artifacts ?? [],
    reports: role.reports ?? [],
    binding: role.binding,
    logAssertions: role.logAssertions ?? [],
  };
  assert(stableJson(actual) === stableJson(contract), `${label} contract differs`);
}

function validatePackageEquivalenceRoleContracts(policy, rolesById) {
  const roleIds = [
    policy.packageEquivalence.sourceRole,
    policy.packageEquivalence.targetRole,
    policy.packageEquivalence.telegramRole,
  ];
  assert(
    new Set(roleIds).size === roleIds.length,
    "packageEquivalence roles must be three distinct roles",
  );
  const roles = roleIds.map((roleId) => rolesById.get(roleId));
  const inputPools = roles.map((role) => role.input);
  assert(
    new Set(inputPools).size === inputPools.length &&
      roles.every(
        (role) => role.input !== "producer" && policy.inputs[role.input]?.cardinality === "one",
      ),
    "packageEquivalence roles require distinct single-run input pools",
  );
  validatePackageRoleContract(
    roles[0],
    npmPackageRoleContract(policy, "reused"),
    "packageEquivalence source npm role",
  );
  validatePackageRoleContract(
    roles[1],
    npmPackageRoleContract(policy, "fresh"),
    "packageEquivalence target npm role",
  );
  validatePackageRoleContract(
    roles[2],
    telegramPackageRoleContract(),
    "packageEquivalence Telegram role",
  );
}

function clawHubArtifactBase(packageName, version) {
  const slug = packageName.replace(/^@/u, "").replace(/[^A-Za-z0-9_.-]+/gu, "-");
  return `clawhub-package-${slug}-${version}`;
}

function validateClawHubPackageRoleContract(role, entry, mode, version, label) {
  assert(role.mode === mode && role.input !== "producer", `${label} role mode is invalid`);
  const base = clawHubArtifactBase(entry.name, version);
  const packageArtifact = role.artifacts?.find((artifact) => artifact.key === "package");
  assert(
    role.artifacts?.length === 3 &&
      packageArtifact?.name === base &&
      packageArtifact.files.length === 1 &&
      packageArtifact.files[0].path.endsWith(".tgz") &&
      stableJson(
        role.artifacts
          .filter((artifact) => artifact.key !== "package")
          .toSorted((left, right) => left.key.localeCompare(right.key)),
      ) ===
        stableJson(
          [
            {
              key: "inspector",
              name: `${base}-inspector`,
              files: [
                { path: "plugin-inspector-issues.md" },
                { path: "plugin-inspector-report.json" },
                { path: "plugin-inspector-report.md" },
              ],
            },
            {
              key: "publish-json",
              name: `${base}-publish-json`,
              files: [{ path: "package-publish.json" }],
            },
          ].toSorted((left, right) => left.key.localeCompare(right.key)),
        ),
    `${label} role artifact contract is invalid`,
  );
  const expectedCommit = mode === "reused" ? "$sourceSha" : "$targetSha";
  const expectedReports = [
    {
      artifactKey: "inspector",
      path: "plugin-inspector-report.json",
      format: "json",
      assertions: [
        { pointer: "/status", op: "eq", value: "pass" },
        { pointer: "/summary/breakageCount", op: "eq", value: 0 },
        { pointer: "/fixtures", op: "length", value: 1 },
        { pointer: "/fixtures/0/status", op: "eq", value: "ok" },
        { pointer: "/fixtures/0/package/name", op: "eq", value: entry.name },
        { pointer: "/fixtures/0/package/version", op: "eq", value: version },
      ],
    },
    {
      artifactKey: "publish-json",
      path: "package-publish.json",
      format: "json",
      assertions: [
        { pointer: "/name", op: "eq", value: entry.name },
        { pointer: "/version", op: "eq", value: version },
        { pointer: "/commit", op: "eq", value: expectedCommit },
      ],
    },
  ];
  assert(
    stableJson(role.reports ?? []) === stableJson(expectedReports) &&
      stableJson(role.binding) ===
        stableJson({
          type: "artifact-json",
          artifactKey: "publish-json",
          path: "package-publish.json",
          pointer: "/commit",
          expected: mode === "reused" ? "source" : "target",
        }),
    `${label} role report or binding contract is invalid`,
  );
}

export function validateClawHubPublishDocument(
  document,
  { packageName, version, commit },
  label = "ClawHub publish JSON",
) {
  exactObject(
    document,
    ["source", "name", "displayName", "family", "version", "commit", "files", "totalBytes"],
    [],
    label,
  );
  assert(
    typeof document.source === "string" &&
      document.source.length > 0 &&
      typeof document.displayName === "string" &&
      document.displayName.length > 0 &&
      ["code-plugin", "bundle-plugin"].includes(document.family) &&
      document.name === packageName &&
      document.version === version &&
      document.commit === commit &&
      Number.isSafeInteger(document.files) &&
      document.files > 0 &&
      Number.isSafeInteger(document.totalBytes) &&
      document.totalBytes > 0,
    `${label} identity differs`,
  );
  return document;
}

export function parseReleaseDeltaPolicy(raw) {
  const policy = parseJson(raw, "release delta policy");
  exactObject(
    policy,
    [
      "schemaVersion",
      "release",
      "git",
      "inputs",
      "roles",
      "cancelledAggregate",
      "packageEquivalence",
      "clawHub",
      "ledger",
    ],
    [],
    "policy",
  );
  assert(policy.schemaVersion === 3, "policy.schemaVersion must be 3");

  exactObject(
    policy.release,
    ["version", "tag", "targetRef", "changelogBaseRef"],
    [],
    "policy.release",
  );
  assert(BETA_VERSION_RE.test(policy.release.version), "policy.release.version is invalid");
  assert(
    policy.release.tag === `v${policy.release.version}`,
    "policy.release.tag differs from version",
  );
  assert(
    policy.release.targetRef === `release/${policy.release.version.replace(/-beta\.\d+$/u, "")}`,
    "policy.release.targetRef differs from version",
  );
  assert(
    STABLE_RELEASE_TAG_RE.test(policy.release.changelogBaseRef) &&
      policy.release.changelogBaseRef !== policy.release.tag,
    "policy.release.changelogBaseRef is invalid",
  );

  exactObject(
    policy.git,
    [
      "baselineSha",
      "sourceSha",
      "allowedPathPatterns",
      "metadataPaths",
      "trustedDocs",
      "trustBundlePaths",
      "terminalCommit",
    ],
    [],
    "policy.git",
  );
  for (const key of ["baselineSha", "sourceSha"]) {
    validSha(policy.git[key], `policy.git.${key}`);
  }
  uniqueStrings(policy.git.allowedPathPatterns, "policy.git.allowedPathPatterns").forEach(
    (pattern, index) => {
      try {
        new RegExp(pattern, "u");
      } catch {
        fail(`policy.git.allowedPathPatterns[${index}] is invalid`);
      }
    },
  );
  assert(
    policy.git.terminalCommit === "changelog-only",
    "policy.git.terminalCommit must be changelog-only",
  );
  for (const key of ["metadataPaths", "trustedDocs", "trustBundlePaths"]) {
    uniqueStrings(policy.git[key], `policy.git.${key}`).forEach((entry, index) =>
      validPath(entry, `policy.git.${key}[${index}]`),
    );
  }
  assert(
    policy.git.metadataPaths.every((filePath) => RELEASE_METADATA_PATH_RE.test(filePath)),
    "policy.git.metadataPaths contains a product, workflow, or tooling path",
  );
  assert(
    policy.git.metadataPaths.every((filePath) =>
      policy.git.allowedPathPatterns.some((pattern) => new RegExp(pattern, "u").test(filePath)),
    ),
    "policy.git.metadataPaths must be allowed by allowedPathPatterns",
  );
  assert(
    JSON.stringify(policy.git.trustedDocs.toSorted()) ===
      JSON.stringify(
        [
          "docs/ci.md",
          "docs/reference/RELEASING.md",
          "docs/reference/full-release-validation.md",
        ].toSorted(),
      ),
    "policy.git.trustedDocs differs from the audited release documentation set",
  );

  assert(
    policy.inputs && typeof policy.inputs === "object" && !Array.isArray(policy.inputs),
    "policy.inputs is invalid",
  );
  const inputNames = new Set(Object.keys(policy.inputs));
  assert(inputNames.size > 0, "policy.inputs must not be empty");
  for (const [name, input] of Object.entries(policy.inputs)) {
    assert(/^[a-z][A-Za-z0-9]*$/u.test(name), `policy.inputs.${name} is invalid`);
    exactObject(input, ["cardinality"], ["count"], `policy.inputs.${name}`);
    assert(
      ["one", "nonempty", "exact"].includes(input.cardinality),
      `policy.inputs.${name}.cardinality is invalid`,
    );
    if (input.cardinality === "exact") {
      assert(
        Number.isSafeInteger(input.count) && input.count > 0,
        `policy.inputs.${name}.count is invalid`,
      );
    } else {
      assert(input.count === undefined, `policy.inputs.${name}.count is unsupported`);
    }
  }

  assert(Array.isArray(policy.roles) && policy.roles.length > 0, "policy.roles must not be empty");
  policy.roles.forEach((role, index) => parseRole(role, inputNames, index));
  const roleIds = policy.roles.map((role) => role.id);
  assert(new Set(roleIds).size === roleIds.length, "policy.roles contains duplicate ids");
  const roleIdSet = new Set(roleIds);
  const rolesById = new Map(policy.roles.map((role) => [role.id, role]));
  const producerRoles = policy.roles.filter((role) => role.input === "producer");
  assert(
    new Set(producerRoles.map((role) => role.producerJob)).size === producerRoles.length,
    "policy.roles contains duplicate producer jobs",
  );
  producerRoles.forEach((role) => validateProducerRoleContract(role, `policy role ${role.id}`));
  for (const input of inputNames) {
    assert(
      policy.roles.some((role) => role.input === input) ||
        policy.cancelledAggregate?.input === input,
      `policy input ${input} is unused`,
    );
  }

  exactObject(
    policy.cancelledAggregate,
    [
      "input",
      "workflow",
      "run",
      "sourceBinding",
      "completedJobs",
      "successfulJobs",
      "skippedJobs",
      "dispositions",
    ],
    [],
    "policy.cancelledAggregate",
  );
  assert(inputNames.has(policy.cancelledAggregate.input), "cancelledAggregate.input is unknown");
  validPath(policy.cancelledAggregate.workflow, "cancelledAggregate.workflow");
  exactObject(
    policy.cancelledAggregate.run,
    ["event", "headBranch", "attempt", "conclusion"],
    [],
    "policy.cancelledAggregate.run",
  );
  assert(
    typeof policy.cancelledAggregate.run.event === "string" &&
      policy.cancelledAggregate.run.event.length > 0 &&
      typeof policy.cancelledAggregate.run.headBranch === "string" &&
      policy.cancelledAggregate.run.headBranch.length > 0 &&
      policy.cancelledAggregate.run.attempt === 1 &&
      policy.cancelledAggregate.run.conclusion === "cancelled",
    "cancelledAggregate.run is invalid",
  );
  exactObject(
    policy.cancelledAggregate.sourceBinding,
    ["jobName", "marker"],
    ["prefix"],
    "policy.cancelledAggregate.sourceBinding",
  );
  assert(
    typeof policy.cancelledAggregate.sourceBinding.jobName === "string" &&
      policy.cancelledAggregate.sourceBinding.jobName.length > 0 &&
      typeof policy.cancelledAggregate.sourceBinding.marker === "string" &&
      policy.cancelledAggregate.sourceBinding.marker.length > 0 &&
      (policy.cancelledAggregate.sourceBinding.prefix === undefined ||
        typeof policy.cancelledAggregate.sourceBinding.prefix === "string"),
    "cancelledAggregate.sourceBinding is invalid",
  );
  exactObject(
    policy.cancelledAggregate.completedJobs,
    ["count", "namesAndConclusionsSha256"],
    [],
    "policy.cancelledAggregate.completedJobs",
  );
  assert(
    Number.isSafeInteger(policy.cancelledAggregate.completedJobs.count) &&
      policy.cancelledAggregate.completedJobs.count > 0,
    "cancelledAggregate.completedJobs.count is invalid",
  );
  validSha256(
    policy.cancelledAggregate.completedJobs.namesAndConclusionsSha256,
    "cancelledAggregate.completedJobs.namesAndConclusionsSha256",
  );
  exactObject(
    policy.cancelledAggregate.successfulJobs,
    ["count", "namesSha256"],
    [],
    "policy.cancelledAggregate.successfulJobs",
  );
  assert(
    Number.isSafeInteger(policy.cancelledAggregate.successfulJobs.count) &&
      policy.cancelledAggregate.successfulJobs.count > 0,
    "cancelledAggregate.successfulJobs.count is invalid",
  );
  validSha256(
    policy.cancelledAggregate.successfulJobs.namesSha256,
    "cancelledAggregate.successfulJobs.namesSha256",
  );
  exactObject(
    policy.cancelledAggregate.skippedJobs,
    ["count", "namesSha256"],
    [],
    "policy.cancelledAggregate.skippedJobs",
  );
  assert(
    Number.isSafeInteger(policy.cancelledAggregate.skippedJobs.count) &&
      policy.cancelledAggregate.skippedJobs.count >= 0,
    "cancelledAggregate.skippedJobs.count is invalid",
  );
  validSha256(
    policy.cancelledAggregate.skippedJobs.namesSha256,
    "cancelledAggregate.skippedJobs.namesSha256",
  );
  assert(
    Array.isArray(policy.cancelledAggregate.dispositions) &&
      policy.cancelledAggregate.dispositions.length === 4,
    "cancelledAggregate.dispositions must contain four entries",
  );
  for (const [index, disposition] of policy.cancelledAggregate.dispositions.entries()) {
    const label = `policy.cancelledAggregate.dispositions[${index}]`;
    exactObject(disposition, ["name", "conclusion", "resolution"], [], label);
    assert(
      typeof disposition.name === "string" && disposition.name.length > 0,
      `${label}.name is invalid`,
    );
    assert(
      ["failure", "cancelled"].includes(disposition.conclusion),
      `${label}.conclusion is invalid`,
    );
    exactObject(disposition.resolution, ["kind", "roles"], [], `${label}.resolution`);
    assert(
      ["replacement", "separate-closure", "aggregate"].includes(disposition.resolution.kind),
      `${label}.resolution.kind is invalid`,
    );
    uniqueStrings(disposition.resolution.roles, `${label}.resolution.roles`);
    assert(
      disposition.resolution.roles.every((role) => roleIdSet.has(role)),
      `${label}.resolution references an unknown role`,
    );
  }
  assert(
    new Set(policy.cancelledAggregate.dispositions.map((entry) => entry.name)).size ===
      policy.cancelledAggregate.dispositions.length,
    "cancelledAggregate.dispositions contains duplicate names",
  );

  exactObject(
    policy.packageEquivalence,
    ["sourceRole", "targetRole", "telegramRole", "rules"],
    [],
    "policy.packageEquivalence",
  );
  for (const key of ["sourceRole", "targetRole", "telegramRole"]) {
    assert(roleIdSet.has(policy.packageEquivalence[key]), `packageEquivalence.${key} is unknown`);
  }
  exactObject(
    policy.packageEquivalence.rules,
    ["rootPackageComparison", "aiPackageComparison"],
    [],
    "policy.packageEquivalence.rules",
  );
  assert(
    ["canonical", "fresh-target"].includes(policy.packageEquivalence.rules.rootPackageComparison) &&
      ["raw-sha256", "fresh-target"].includes(policy.packageEquivalence.rules.aiPackageComparison),
    "packageEquivalence.rules is invalid",
  );
  validatePackageEquivalenceRoleContracts(policy, rolesById);

  exactObject(policy.clawHub, ["reused", "fresh"], [], "policy.clawHub");
  const packages = [];
  const packageRoles = [];
  for (const key of ["reused", "fresh"]) {
    assert(Array.isArray(policy.clawHub[key]), `policy.clawHub.${key} must be an array`);
    for (const [index, entry] of policy.clawHub[key].entries()) {
      exactObject(entry, ["name", "role"], [], `policy.clawHub.${key}[${index}]`);
      assert(
        /^@openclaw\/[a-z0-9][a-z0-9-]*$/u.test(entry.name),
        `policy.clawHub.${key}[${index}].name is invalid`,
      );
      assert(roleIdSet.has(entry.role), `policy.clawHub.${key}[${index}].role is unknown`);
      packages.push(entry.name);
      packageRoles.push(entry.role);
      validateClawHubPackageRoleContract(
        policy.roles.find((role) => role.id === entry.role),
        entry,
        key,
        policy.release.version,
        `policy.clawHub.${key}[${index}]`,
      );
    }
  }
  assert(packages.length > 0, "policy.clawHub package roster is empty");
  assert(new Set(packages).size === packages.length, "policy.clawHub package roster overlaps");
  assert(
    new Set(packageRoles).size === packageRoles.length,
    "policy.clawHub packages must use unique evidence roles",
  );

  exactObject(policy.ledger, ["adapterSchemaVersion", "assertions"], [], "policy.ledger");
  assert(policy.ledger.adapterSchemaVersion === 2, "policy.ledger adapter must be v2");
  assert(
    Array.isArray(policy.ledger.assertions) && policy.ledger.assertions.length > 0,
    "policy.ledger.assertions is empty",
  );
  policy.ledger.assertions.forEach((assertion, index) =>
    parseAssertion(assertion, `policy.ledger.assertions[${index}]`),
  );
  return policy;
}

export function parseEvidenceRuns(raw, policy) {
  const value = parseJson(raw, "evidence runs");
  exactObject(value, Object.keys(policy.inputs), [], "evidence runs");
  const seen = new Set();
  return Object.fromEntries(
    Object.entries(policy.inputs).map(([name, contract]) => {
      const values = Array.isArray(value[name]) ? value[name] : [value[name]];
      const expectedCount =
        contract.cardinality === "one"
          ? 1
          : contract.cardinality === "exact"
            ? contract.count
            : null;
      assert(
        values.length > 0 && (expectedCount === null || values.length === expectedCount),
        `${name} has invalid cardinality`,
      );
      const ids = values.map((entry, index) => parsePositiveDecimalId(entry, `${name}[${index}]`));
      assert(new Set(ids).size === ids.length, `${name} contains duplicate run ids`);
      for (const id of ids) {
        assert(!seen.has(id), `run ${id} appears in multiple evidence groups`);
        seen.add(id);
      }
      return [name, ids];
    }),
  );
}

function namesBetween(cwd, left, right) {
  return git(cwd, ["diff", "--name-only", left, right])
    .trim()
    .split("\n")
    .filter(Boolean)
    .toSorted();
}

function commitPaths(cwd, parent, commit) {
  return git(cwd, ["diff-tree", "--no-commit-id", "--name-only", "-r", parent, commit])
    .trim()
    .split("\n")
    .filter(Boolean)
    .toSorted();
}

function treeDigest(cwd, revision, ignoredPaths) {
  const ignored = new Set(ignoredPaths);
  const entries = git(cwd, ["ls-tree", "-r", "-z", "--full-tree", revision], "buffer")
    .toString("utf8")
    .split("\0")
    .filter((entry) => entry && !ignored.has(entry.slice(entry.indexOf("\t") + 1)));
  return sha256(`${entries.join("\0")}\0`);
}

export function validateReleaseDelta(cwd, policy, targetSha) {
  const { baselineSha, sourceSha, allowedPathPatterns, metadataPaths } = policy.git;
  validSha(targetSha, "target SHA");
  assert(targetSha !== sourceSha, "target SHA equals source SHA");
  assert(
    spawnSync("git", ["merge-base", "--is-ancestor", sourceSha, targetSha], { cwd }).status === 0,
    "source is not an ancestor of target",
  );
  const commits = git(cwd, [
    "rev-list",
    "--first-parent",
    "--reverse",
    `${sourceSha}..${targetSha}`,
  ])
    .trim()
    .split("\n")
    .filter(Boolean);
  assert(
    commits.length > 0 && commits.at(-1) === targetSha,
    "release delta has no terminal commit",
  );

  let parent = sourceSha;
  const touched = new Set();
  const commitPathAudit = commits.map((commit) => {
    const parents = git(cwd, ["rev-list", "--parents", "-n", "1", commit]).trim().split(" ");
    assert(parents.length === 2 && parents[1] === parent, `commit ${commit} is not a linear child`);
    const paths = commitPaths(cwd, parent, commit);
    assert(paths.length > 0, `commit ${commit} has no changed paths`);
    paths.forEach((entry) => touched.add(entry));
    parent = commit;
    return { sha: commit, parent: parents[1], changedPaths: paths };
  });
  const finalTargetParentSha = commitPathAudit.at(-1)?.parent;
  assert(SHA_RE.test(finalTargetParentSha ?? ""), "final target parent is invalid");
  assert(
    JSON.stringify(commitPathAudit.at(-1)?.changedPaths) === JSON.stringify(["CHANGELOG.md"]),
    "final target commit is not CHANGELOG-only",
  );

  const endpointPaths = namesBetween(cwd, sourceSha, targetSha);
  assert(
    JSON.stringify([...touched].toSorted()) === JSON.stringify(endpointPaths),
    "commit-range path union differs from endpoint",
  );
  const allowedMatchers = allowedPathPatterns.map((pattern) => new RegExp(pattern, "u"));
  const metadata = new Set(metadataPaths);
  for (const changedPath of endpointPaths) {
    assert(
      allowedMatchers.some((matcher) => matcher.test(changedPath)),
      `changed path is not allowed by policy: ${changedPath}`,
    );
    if (metadata.has(changedPath)) continue;
    const matchingRoles = policy.roles.filter((role) =>
      role.impactPatterns.some((pattern) => new RegExp(pattern, "u").test(changedPath)),
    );
    assert(
      matchingRoles.some((role) => role.mode === "fresh"),
      `changed path has no fresh evidence role: ${changedPath}`,
    );
    assert(
      matchingRoles.every((role) => role.mode === "fresh"),
      `changed path matches a reused evidence role: ${changedPath}`,
    );
  }

  assert(
    git(cwd, ["rev-parse", `${sourceSha}^`]).trim() === baselineSha,
    "source is not a direct baseline child",
  );
  const baselineChangedPaths = commitPaths(cwd, baselineSha, sourceSha);
  assert(
    JSON.stringify(baselineChangedPaths) === JSON.stringify(["CHANGELOG.md"]),
    "baseline to source is not CHANGELOG-only",
  );
  const baselineSha256 = treeDigest(cwd, baselineSha, ["CHANGELOG.md"]);
  const baselineSourceSha256 = treeDigest(cwd, sourceSha, ["CHANGELOG.md"]);
  assert(baselineSha256 === baselineSourceSha256, "baseline product tree differs from source");
  const sourceSha256 = treeDigest(cwd, sourceSha, metadataPaths);
  const targetSha256 = treeDigest(cwd, targetSha, metadataPaths);
  return {
    sourceSha,
    parentSha: finalTargetParentSha,
    targetSha,
    changedPaths: endpointPaths,
    touchedPaths: [...touched].toSorted(),
    commitPathAudit,
    runtimeTree: {
      baselineAlgorithm: "git-tree-excluding-changelog-v1",
      baselineChangedPaths,
      baselineSha256,
      baselineSourceSha256,
      terminalAlgorithm: "git-tree-excluding-policy-metadata-paths-v3",
      sourceSha256,
      targetSha256,
      equivalent: sourceSha256 === targetSha256,
    },
  };
}

export function computeTrustBundle(cwd, policy, workflowSha) {
  validSha(workflowSha, "workflow SHA");
  const entries = policy.git.trustBundlePaths.map((filePath) => {
    const blobSha = git(cwd, ["rev-parse", `${workflowSha}:${filePath}`]).trim();
    const content = git(cwd, ["show", `${workflowSha}:${filePath}`], "buffer");
    validSha(blobSha, `trust bundle blob for ${filePath}`);
    return { path: filePath, blobSha, sha256: sha256(content) };
  });
  return {
    algorithm: "sha256-stable-json-v1",
    entries,
    digest: sha256(stableJson(entries)),
  };
}

async function page(deps, apiPath, key) {
  const values = [];
  for (let number = 1; ; number += 1) {
    const separator = apiPath.includes("?") ? "&" : "?";
    const response = await deps.api(`${apiPath}${separator}per_page=100&page=${number}`);
    const entries = response?.[key] ?? [];
    assert(Array.isArray(entries), `${apiPath} returned invalid ${key}`);
    values.push(...entries);
    if (entries.length < 100) return values;
  }
}

function record(value, keys) {
  return Object.fromEntries(keys.map((key) => [key, value[key]]));
}

function template(value, context) {
  if (typeof value !== "string") return value;
  return value
    .replaceAll("{sourceSha}", context.sourceSha)
    .replaceAll("{targetSha}", context.targetSha)
    .replaceAll("{runId}", String(context.runId ?? ""))
    .replaceAll("{runAttempt}", String(context.runAttempt ?? ""));
}

function assertionValue(value, context) {
  if (typeof value !== "string" || !value.startsWith("$")) return value;
  const key = value.slice(1);
  assert(Object.hasOwn(context, key), `assertion token ${value} is unavailable`);
  return context[key];
}

function pointerValues(document, pointer) {
  const tokens = pointer
    .slice(1)
    .split("/")
    .map((entry) => entry.replaceAll("~1", "/").replaceAll("~0", "~"));
  let values = [document];
  for (const token of tokens) {
    const next = [];
    for (const value of values) {
      if (token === "*") {
        if (Array.isArray(value)) next.push(...value);
        else if (value && typeof value === "object") next.push(...Object.values(value));
      } else if (value && typeof value === "object" && Object.hasOwn(value, token)) {
        next.push(value[token]);
      }
    }
    values = next;
  }
  return values;
}

function checkAssertions(document, assertions, context, label) {
  for (const [index, assertion] of assertions.entries()) {
    const values = pointerValues(document, assertion.pointer);
    assert(values.length > 0, `${label} assertion ${index} resolved no values`);
    const expected = assertionValue(assertion.value, context);
    let passed = false;
    if (assertion.op === "eq" || assertion.op === "all-eq") {
      passed = values.every((value) => stableJson(value) === stableJson(expected));
    } else if (assertion.op === "matches") {
      const matcher = new RegExp(expected, "u");
      passed = values.every((value) => typeof value === "string" && matcher.test(value));
    } else if (assertion.op === "length") {
      passed = values.every((value) => value != null && value.length === expected);
    } else if (assertion.op === "includes") {
      passed = values.every(
        (value) =>
          (Array.isArray(value) &&
            value.some((entry) => stableJson(entry) === stableJson(expected))) ||
          (typeof value === "string" && value.includes(expected)),
      );
    } else if (assertion.op === "sha256") {
      passed = values.every((value) => sha256(stableJson(value)) === expected);
    }
    assert(passed, `${label} assertion ${index} failed at ${assertion.pointer}`);
  }
}

function literalCount(value, pattern) {
  let count = 0;
  let index = 0;
  while ((index = value.indexOf(pattern, index)) !== -1) {
    count += 1;
    index += pattern.length;
  }
  return count;
}

export function validateNoChainedReleaseDeltaEvidence(document, label = "evidence") {
  assert(document?.kind !== KIND, `${label} must not consume release delta evidence`);
  return document;
}

function validateJobNameSet(jobs, expected, label, { allowEmpty = false } = {}) {
  assert(Array.isArray(jobs) && (allowEmpty || jobs.length > 0), `${label} job set is empty`);
  const names = jobs.map((job) => job?.name);
  assert(
    names.every((name) => typeof name === "string" && name.length > 0),
    `${label} job set contains an invalid name`,
  );
  const canonical = `${names.toSorted().join("\n")}\n`;
  const actual = { count: names.length, namesSha256: sha256(canonical) };
  assert(
    actual.count === expected.count && actual.namesSha256 === expected.namesSha256,
    `cancelled aggregate ${label} job set differs`,
  );
  return actual;
}

export function validateSuccessfulJobSet(jobs, expected) {
  return validateJobNameSet(jobs, expected, "successful");
}

export function validateCompletedJobSet(jobs, expected) {
  assert(Array.isArray(jobs) && jobs.length > 0, "completed job set is empty");
  const identities = jobs.map((job) => {
    assert(
      typeof job?.name === "string" &&
        job.name.length > 0 &&
        typeof job.conclusion === "string" &&
        ["success", "skipped", "failure", "cancelled"].includes(job.conclusion),
      "completed job set contains an invalid identity",
    );
    return `${job.name}\t${job.conclusion}`;
  });
  const canonical = `${identities.toSorted().join("\n")}\n`;
  const actual = {
    count: identities.length,
    namesAndConclusionsSha256: sha256(canonical),
  };
  assert(
    actual.count === expected.count &&
      actual.namesAndConclusionsSha256 === expected.namesAndConclusionsSha256,
    "cancelled aggregate completed job set differs",
  );
  return actual;
}

export function selectSuccessfulJobByName(jobs, name, label = "job") {
  const matches = jobs.filter(
    (candidate) =>
      candidate.name === name &&
      candidate.status === "completed" &&
      candidate.conclusion === "success",
  );
  assert(matches.length === 1, `${label} successful job is not unique`);
  return matches[0];
}

function roleExpectedSha(role, context) {
  return context[`${role.binding.expected}Sha`];
}

function runRecord(run) {
  return record(run, [
    "id",
    "run_attempt",
    "name",
    "path",
    "event",
    "head_branch",
    "head_sha",
    "html_url",
    "conclusion",
  ]);
}

function jobRecord(job) {
  return record(job, ["id", "name", "html_url", "conclusion"]);
}

export function createReleaseDeltaResolver(options, deps, runs) {
  const runCache = new Map();
  const jobCache = new Map();
  const artifactCache = new Map();
  const logCache = new Map();
  const artifactBytesCache = new Map();
  const usedRunIds = new Set();

  const fetchRun = async (runId) => {
    if (!runCache.has(runId)) {
      runCache.set(runId, await deps.api(`repos/${deps.repo}/actions/runs/${runId}`));
    }
    return runCache.get(runId);
  };
  const fetchJobs = async (runId) => {
    if (!jobCache.has(runId)) {
      jobCache.set(
        runId,
        await page(deps, `repos/${deps.repo}/actions/runs/${runId}/jobs`, "jobs"),
      );
    }
    return jobCache.get(runId);
  };
  const fetchArtifacts = async (runId) => {
    if (!artifactCache.has(runId)) {
      artifactCache.set(
        runId,
        await page(deps, `repos/${deps.repo}/actions/runs/${runId}/artifacts`, "artifacts"),
      );
    }
    return artifactCache.get(runId);
  };
  const fetchLog = async (jobId) => {
    if (!logCache.has(jobId)) logCache.set(jobId, await deps.jobLog(jobId));
    return logCache.get(jobId);
  };
  const fetchArtifactBytes = async (artifact, filePath) => {
    const key = `${artifact.id}:${filePath}`;
    if (!artifactBytesCache.has(key)) {
      artifactBytesCache.set(key, await deps.artifactBytes(artifact, filePath));
    }
    return artifactBytesCache.get(key);
  };

  async function resolveCandidate(role, runId, context) {
    const impactedPaths = options.delta.changedPaths.filter((changedPath) =>
      role.impactPatterns.some((pattern) => new RegExp(pattern, "u").test(changedPath)),
    );
    assert(
      role.mode === "fresh" || impactedPaths.length === 0,
      `role ${role.id} reuses evidence across impacted paths: ${impactedPaths.join(", ")}`,
    );
    const run = await fetchRun(runId);
    const expectedHeadBranch = template(role.run.headBranch, context);
    const currentProducerRun = role.input === "producer";
    const runStateValid = currentProducerRun
      ? run?.status === "in_progress" &&
        run?.conclusion == null &&
        run?.id === options.producer.runId &&
        run?.head_sha === options.workflowSha
      : run?.status === "completed" && role.run.conclusions.includes(run?.conclusion);
    assert(
      run?.id === runId &&
        runStateValid &&
        run.run_attempt === role.run.attempt &&
        run.path === role.workflow &&
        run.event === role.run.event &&
        run.head_branch === expectedHeadBranch &&
        SHA_RE.test(run.head_sha ?? ""),
      `role ${role.id} run ${runId} violates provenance`,
    );

    const jobs = await fetchJobs(runId);
    const jobMatches = jobs.filter(
      (job) =>
        job.name === role.job.name &&
        job.status === "completed" &&
        job.conclusion === role.job.conclusion,
    );
    assert(jobMatches.length === 1, `role ${role.id} does not resolve one successful job`);
    const job = jobMatches[0];

    const artifacts = [];
    const artifactMap = new Map();
    const availableArtifacts = await fetchArtifacts(runId);
    for (const contract of role.artifacts ?? []) {
      const name = template(contract.name, { ...context, runId, runAttempt: run.run_attempt });
      const matches = availableArtifacts.filter(
        (artifact) =>
          artifact.name === name &&
          artifact.workflow_run?.id === runId &&
          artifact.expired === false &&
          DIGEST_RE.test(artifact.digest ?? ""),
      );
      assert(matches.length === 1, `role ${role.id} artifact ${contract.key} is not unique`);
      const artifact = matches[0];
      await deps.verifyArtifact(artifact);
      validateArtifactInventory(
        await deps.artifactEntries(artifact),
        contract.files.map((file) => file.path),
        `role ${role.id} artifact ${contract.key}`,
      );
      const files = [];
      for (const file of contract.files) {
        const bytes = await fetchArtifactBytes(artifact, file.path);
        const digest = sha256(bytes);
        assert(
          file.sha256 === undefined || file.sha256 === digest,
          `role ${role.id} file ${file.path} hash differs`,
        );
        files.push({ path: file.path, sha256: digest, size: bytes.length });
      }
      const evidence = {
        key: contract.key,
        ...record(artifact, ["id", "name", "digest", "size_in_bytes", "expired"]),
        runId,
        files,
      };
      artifacts.push(evidence);
      artifactMap.set(contract.key, { metadata: artifact, evidence });
    }

    const reportEvidence = [];
    for (const report of role.reports ?? []) {
      const artifact = artifactMap.get(report.artifactKey);
      const bytes = await fetchArtifactBytes(artifact.metadata, report.path);
      const document = parseJson(bytes, `role ${role.id} report ${report.path}`);
      if (role.input !== "producer") {
        validateNoChainedReleaseDeltaEvidence(document, `role ${role.id}`);
      }
      checkAssertions(
        document,
        report.assertions,
        context,
        `role ${role.id} report ${report.path}`,
      );
      reportEvidence.push({
        artifactKey: report.artifactKey,
        path: report.path,
        sha256: sha256(bytes),
        size: bytes.length,
      });
    }

    const logEvidence = [];
    for (const entry of role.logAssertions ?? []) {
      const logJob = selectSuccessfulJobByName(
        jobs,
        entry.jobName,
        `role ${role.id} log assertion`,
      );
      const log = await fetchLog(logJob.id);
      assert(
        literalCount(log, entry.pattern) === entry.count,
        `role ${role.id} log assertion differs for ${entry.pattern}`,
      );
      logEvidence.push({
        jobId: logJob.id,
        pattern: entry.pattern,
        count: entry.count,
        sha256: sha256(log),
      });
    }

    const expectedSha = roleExpectedSha(role, context);
    let binding;
    if (role.binding.type === "run-head") {
      assert(run.head_sha === expectedSha, `role ${role.id} run head differs from candidate`);
      binding = { type: "run-head", expectedSha };
    } else if (role.binding.type === "job-log") {
      const bindingJob = job;
      const log = await fetchLog(bindingJob.id);
      const line = `${role.binding.marker}: ${role.binding.prefix ?? ""}${expectedSha}`;
      assert(literalCount(log, line) === 1, `role ${role.id} does not bind ${line}`);
      binding = {
        type: "job-log",
        expectedSha,
        jobId: bindingJob.id,
        marker: role.binding.marker,
        sha256: sha256(log),
      };
    } else {
      const artifact = artifactMap.get(role.binding.artifactKey);
      const bytes = await fetchArtifactBytes(artifact.metadata, role.binding.path);
      const document = parseJson(bytes, `role ${role.id} binding`);
      if (role.input !== "producer") {
        validateNoChainedReleaseDeltaEvidence(document, `role ${role.id}`);
      }
      const values = pointerValues(document, role.binding.pointer);
      assert(
        values.length === 1 && values[0] === expectedSha,
        `role ${role.id} artifact binding differs from candidate`,
      );
      binding = {
        type: "artifact-json",
        expectedSha,
        artifactKey: role.binding.artifactKey,
        path: role.binding.path,
        pointer: role.binding.pointer,
        sha256: sha256(bytes),
      };
    }
    usedRunIds.add(runId);
    return {
      id: role.id,
      gate: role.gate,
      mode: role.mode,
      sourceSha: options.policy.git.sourceSha,
      targetSha: options.targetSha,
      changedPaths: options.delta.changedPaths,
      impactPatterns: role.impactPatterns,
      impactedPaths,
      reuseRationale:
        role.mode === "fresh"
          ? "Fresh exact-target evidence required by policy."
          : "No target delta path matched this role's declared impact patterns.",
      run: runRecord(run),
      job: jobRecord(job),
      artifacts,
      reports: reportEvidence,
      logs: logEvidence,
      binding,
      conclusion: "success",
    };
  }

  async function resolveRole(role, context) {
    const allowedRunIds = role.input === "producer" ? [options.producer.runId] : runs[role.input];
    const candidateRunIds = allowedRunIds;
    assert(candidateRunIds.length > 0, `role ${role.id} has no declared run candidates`);
    const matches = [];
    const errors = [];
    for (const runId of candidateRunIds) {
      try {
        matches.push(await resolveCandidate(role, runId, context));
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }
    assert(
      matches.length === 1,
      `role ${role.id} resolved ${matches.length} candidates${
        errors.length > 0 ? `: ${errors.join(" | ")}` : ""
      }`,
    );
    return matches[0];
  }

  return {
    resolveRole,
    fetchRun,
    fetchJobs,
    fetchArtifacts,
    fetchLog,
    fetchArtifactBytes,
    usedRunIds,
  };
}

function artifactForPath(roleEvidence, filePath) {
  const matches = roleEvidence.artifacts.filter((artifact) =>
    artifact.files.some((file) => file.path === filePath),
  );
  assert(matches.length === 1, `role ${roleEvidence.id} does not bind one ${filePath} artifact`);
  return matches[0];
}

async function npmPackage(roleEvidence, expectedSha, context, resolver, label) {
  const artifactEvidence = artifactForPath(roleEvidence, "preflight-manifest.json");
  const artifacts = await resolver.fetchArtifacts(roleEvidence.run.id);
  const artifact = artifacts.find((candidate) => candidate.id === artifactEvidence.id);
  const manifestRaw = await resolver.fetchArtifactBytes(artifact, "preflight-manifest.json");
  const manifest = parseJson(manifestRaw, `${label} npm manifest`);
  exactObject(
    manifest,
    [
      "version",
      "releaseTag",
      "releaseSha",
      "npmDistTag",
      "packageName",
      "packageVersion",
      "tarballName",
      "tarballSha256",
      "dependencyTarballs",
      "dependencyEvidenceDir",
      "dependencyEvidenceManifest",
    ],
    [],
    `${label} npm manifest`,
  );
  assert(
    manifest.version === 1 &&
      manifest.releaseSha === expectedSha &&
      manifest.releaseTag === context.tag &&
      manifest.npmDistTag === "beta" &&
      manifest.packageName === "openclaw" &&
      manifest.packageVersion === context.version &&
      path.basename(manifest.tarballName) === manifest.tarballName &&
      SHA256_RE.test(manifest.tarballSha256) &&
      Array.isArray(manifest.dependencyTarballs) &&
      manifest.dependencyTarballs.length === 1,
    `${label} npm manifest differs from candidate`,
  );
  const ai = manifest.dependencyTarballs[0];
  assert(
    ai.packageName === "@openclaw/ai" &&
      ai.packageVersion === context.version &&
      path.basename(ai.tarballName) === ai.tarballName &&
      SHA256_RE.test(ai.tarballSha256),
    `${label} AI package metadata differs`,
  );
  const [rootTarball, aiTarball] = await Promise.all([
    resolver.fetchArtifactBytes(artifact, manifest.tarballName),
    resolver.fetchArtifactBytes(artifact, ai.tarballName),
  ]);
  assert(sha256(rootTarball) === manifest.tarballSha256, `${label} root tar hash differs`);
  assert(sha256(aiTarball) === ai.tarballSha256, `${label} AI tar hash differs`);
  return {
    evidenceSha: expectedSha,
    run: roleEvidence.run,
    job: roleEvidence.job,
    artifact: artifactEvidence,
    manifest,
    manifestSha256: sha256(manifestRaw),
    root: { name: manifest.tarballName, sha256: manifest.tarballSha256, bytes: rootTarball },
    ai: { name: ai.tarballName, sha256: ai.tarballSha256, bytes: aiTarball },
  };
}

function gitBlob(cwd, revision, filePath) {
  return {
    blobSha: git(cwd, ["rev-parse", `${revision}:${filePath}`]).trim(),
    bytes: git(cwd, ["show", `${revision}:${filePath}`], "buffer"),
  };
}

async function comparePackages(options, source, target) {
  const rules = options.policy.packageEquivalence.rules;
  if (rules.aiPackageComparison === "raw-sha256") {
    assert(source.ai.sha256 === target.ai.sha256, "@openclaw/ai tarball bytes differ");
  }
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-delta-packages-"));
  try {
    const sourceTarball = path.join(tempRoot, "source.tgz");
    const targetTarball = path.join(tempRoot, "target.tgz");
    await Promise.all([
      fs.writeFile(sourceTarball, source.root.bytes),
      fs.writeFile(targetTarball, target.root.bytes),
    ]);
    const sourceChangelog = git(
      options.cwd,
      ["show", `${options.policy.git.sourceSha}:CHANGELOG.md`],
      "buffer",
    );
    const targetChangelog = git(
      options.cwd,
      ["show", `${options.targetSha}:CHANGELOG.md`],
      "buffer",
    );
    const trustedFiles = options.policy.git.trustedDocs.map((filePath) => {
      const sourceBlob = gitBlob(options.cwd, options.policy.git.sourceSha, filePath);
      const targetBlob = gitBlob(options.cwd, options.targetSha, filePath);
      return {
        path: filePath,
        source: sourceBlob.bytes,
        target: targetBlob.bytes,
        sourceBlobSha: sourceBlob.blobSha,
        targetBlobSha: targetBlob.blobSha,
      };
    });
    let rootComparison;
    if (rules.rootPackageComparison === "canonical") {
      const { compareReleasePackageArtifacts } = await import("./release-package-equivalence.mjs");
      rootComparison = await compareReleasePackageArtifacts({
        sourceTarball,
        targetTarball,
        sourceSha: options.policy.git.sourceSha,
        targetSha: options.targetSha,
        expectedVersion: options.policy.release.version,
        sourceChangelog,
        targetChangelog,
        trustedFiles,
      });
      assert(rootComparison.canonical.equal === true, "root package canonical comparison failed");
    } else {
      rootComparison = {
        mode: "fresh-target",
        raw: {
          sourceSha256: source.root.sha256,
          targetSha256: target.root.sha256,
          equal: source.root.sha256 === target.root.sha256,
        },
      };
    }
    return {
      source: {
        ...source,
        root: { name: source.root.name, sha256: source.root.sha256 },
        ai: { name: source.ai.name, sha256: source.ai.sha256 },
      },
      target: {
        ...target,
        root: { name: target.root.name, sha256: target.root.sha256 },
        ai: { name: target.ai.name, sha256: target.ai.sha256 },
      },
      rootComparison,
      ai: {
        algorithm: rules.aiPackageComparison,
        sourceSha256: source.ai.sha256,
        targetSha256: target.ai.sha256,
        equal: source.ai.sha256 === target.ai.sha256,
      },
      trustedFiles: trustedFiles.map((entry) => ({
        path: entry.path,
        sourceBlobSha: entry.sourceBlobSha,
        targetBlobSha: entry.targetBlobSha,
        sourceSha256: sha256(entry.source),
        targetSha256: sha256(entry.target),
      })),
    };
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

async function validateTelegramConsumption(roleEvidence, packageEvidence, resolver, context) {
  const artifactEvidence = artifactForPath(roleEvidence, "package-consumption.json");
  const artifacts = await resolver.fetchArtifacts(roleEvidence.run.id);
  const artifact = artifacts.find((candidate) => candidate.id === artifactEvidence.id);
  const raw = await resolver.fetchArtifactBytes(artifact, "package-consumption.json");
  const value = parseJson(raw, "Telegram package consumption");
  exactObject(
    value,
    ["schemaVersion", "workflow", "targetSha", "packageVersion", "packageArtifact", "qa"],
    [],
    "Telegram package consumption",
  );
  exactObject(
    value.workflow,
    ["runId", "runAttempt", "path", "sha"],
    [],
    "Telegram package consumption.workflow",
  );
  exactObject(
    value.packageArtifact,
    ["runId", "id", "name", "digest", "root", "ai"],
    [],
    "Telegram package consumption.packageArtifact",
  );
  exactObject(value.packageArtifact.root, ["name", "sha256"], [], "Telegram root package");
  exactObject(value.packageArtifact.ai, ["name", "sha256"], [], "Telegram AI package");
  exactObject(
    value.qa,
    ["providerMode", "scenario", "conclusion"],
    [],
    "Telegram package consumption.qa",
  );
  const target = packageEvidence.target;
  assert(
    value.schemaVersion === 1 &&
      value.workflow.runId === roleEvidence.run.id &&
      value.workflow.runAttempt === 1 &&
      value.workflow.path === ".github/workflows/npm-telegram-beta-e2e.yml" &&
      value.workflow.sha === roleEvidence.run.head_sha &&
      value.targetSha === context.targetSha &&
      value.packageVersion === context.version &&
      value.packageArtifact.runId === target.run.id &&
      value.packageArtifact.id === target.artifact.id &&
      value.packageArtifact.name === target.artifact.name &&
      value.packageArtifact.digest === target.artifact.digest &&
      stableJson(value.packageArtifact.root) === stableJson(target.root) &&
      stableJson(value.packageArtifact.ai) === stableJson(target.ai) &&
      value.qa.providerMode === "mock-openai" &&
      value.qa.scenario === "" &&
      value.qa.conclusion === "success",
    "Telegram package consumption is not bound to the promotable npm artifact",
  );
  return { artifact: artifactEvidence, sha256: sha256(raw), value };
}

async function readClawHubPackageManifest(bytes, label) {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-clawhub-package-"));
  const archive = path.join(tempRoot, "package.tgz");
  const extracted = path.join(tempRoot, "extracted");
  try {
    await fs.writeFile(archive, bytes);
    await fs.mkdir(extracted);
    const seen = new Set();
    let invalidEntry;
    try {
      await listTar({
        file: archive,
        gzip: true,
        strict: true,
        onentry(entry) {
          if (invalidEntry) return;
          const normalized = path.posix.normalize(entry.path);
          const collisionKey = normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
          if (
            entry.path !== normalized ||
            (normalized !== "package" &&
              normalized !== "package/" &&
              !normalized.startsWith("package/")) ||
            path.posix.isAbsolute(entry.path) ||
            entry.path.includes("\\")
          ) {
            invalidEntry = `unsafe archive path ${JSON.stringify(entry.path)}`;
          } else if (seen.has(collisionKey)) {
            invalidEntry = `duplicate archive path ${JSON.stringify(collisionKey)}`;
          } else if (entry.type !== "File" && entry.type !== "Directory") {
            invalidEntry = "link or special archive member";
          } else if (((entry.mode ?? 0) & 0o7000) !== 0) {
            invalidEntry = "special permission bits";
          }
          seen.add(collisionKey);
        },
      });
    } catch (error) {
      fail(`${label} cannot be listed: ${error instanceof Error ? error.message : String(error)}`);
    }
    assert(!invalidEntry, `${label} contains ${invalidEntry}`);
    await extractTar({
      file: archive,
      cwd: extracted,
      gzip: true,
      strict: true,
      preserveOwner: false,
    });
    const manifestPath = path.join(extracted, "package", "package.json");
    const manifestStat = await fs.lstat(manifestPath).catch(() => null);
    assert(manifestStat?.isFile(), `${label} lacks package/package.json`);
    return parseJson(await fs.readFile(manifestPath), `${label} package.json`);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

function validateClawHubRoster(packages, targetSha, version, label) {
  assert(Array.isArray(packages) && packages.length > 0, `${label} packages are invalid`);
  packages.forEach((entry, index) => {
    exactObject(
      entry,
      ["extensionId", "packageDir", "packageName", "version", "channel", "publishTag"],
      [],
      `${label}[${index}]`,
    );
    assert(
      /^[a-z0-9][a-z0-9._-]*$/u.test(entry.extensionId) &&
        entry.packageDir === `extensions/${entry.extensionId}` &&
        /^@openclaw\/[a-z0-9][a-z0-9-]*$/u.test(entry.packageName) &&
        entry.version === version &&
        entry.channel === "beta" &&
        entry.publishTag === "beta",
      `${label}[${index}] has invalid release metadata`,
    );
  });
  assert(
    new Set(packages.map((entry) => entry.packageName)).size === packages.length,
    `${label} contains duplicate package names`,
  );
  assert(
    JSON.stringify(packages.map((entry) => entry.packageName)) ===
      JSON.stringify(packages.map((entry) => entry.packageName).toSorted()),
    `${label} is not deterministic`,
  );
  const manifest = { schemaVersion: 1, targetSha, packages };
  return { ...manifest, manifestSha256: sha256(stableJson(manifest)) };
}

export function computeTargetClawHubRosterAudit(cwd, targetSha, expectedVersion) {
  validSha(targetSha, "target ClawHub roster SHA");
  assert(
    typeof expectedVersion === "string" && BETA_VERSION_RE.test(expectedVersion),
    "target ClawHub roster version is invalid",
  );
  const packagePaths = git(cwd, ["ls-tree", "-r", "--name-only", targetSha, "--", "extensions"])
    .trim()
    .split("\n")
    .filter((filePath) => /^extensions\/[^/]+\/package\.json$/u.test(filePath))
    .toSorted();
  const packages = packagePaths
    .map((filePath) => {
      const packageJson = parseJson(
        git(cwd, ["show", `${targetSha}:${filePath}`]),
        `target ClawHub package ${filePath}`,
      );
      if (packageJson.openclaw?.release?.publishToClawHub !== true) return null;
      const extensionId = filePath.split("/")[1];
      return {
        extensionId,
        packageDir: `extensions/${extensionId}`,
        packageName: packageJson.name,
        version: packageJson.version,
        channel: "beta",
        publishTag: "beta",
      };
    })
    .filter(Boolean)
    .toSorted((left, right) => String(left.packageName).localeCompare(String(right.packageName)));
  return validateClawHubRoster(packages, targetSha, expectedVersion, "target ClawHub git roster");
}

async function targetClawHubAudit(options, roleMap, resolver) {
  const worktreeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-clawhub-roster-"));
  try {
    git(options.cwd, ["worktree", "add", "--detach", worktreeRoot, options.targetSha]);
    await fs.symlink(
      path.join(options.cwd, "node_modules"),
      path.join(worktreeRoot, "node_modules"),
    );
    const program = `
      import {
        collectClawHubPublishablePluginPackages,
        resolveSelectedClawHubPublishablePluginPackages,
      } from "./scripts/lib/plugin-clawhub-release.ts";
      const publishable = collectClawHubPublishablePluginPackages(process.cwd());
      const packages = publishable.map((entry) => ({
        extensionId: entry.extensionId,
        packageDir: entry.packageDir,
        packageName: entry.packageName,
        version: entry.version,
        channel: entry.channel,
        publishTag: entry.publishTag,
      }));
      const impactedPackageNames = resolveSelectedClawHubPublishablePluginPackages({
        plugins: publishable,
        rootDir: process.cwd(),
        gitRange: {
          baseRef: ${JSON.stringify(options.policy.git.sourceSha)},
          headRef: ${JSON.stringify(options.targetSha)},
        },
      }).map((entry) => entry.packageName).toSorted();
      process.stdout.write(JSON.stringify({ packages, impactedPackageNames }));
    `;
    const roster = parseJson(
      execFileSync(
        process.execPath,
        ["--import", "tsx", "--input-type=module", "--eval", program],
        {
          cwd: worktreeRoot,
          encoding: "utf8",
          maxBuffer: 32 * 1024 * 1024,
        },
      ),
      "target ClawHub roster",
    );
    exactObject(roster, ["packages", "impactedPackageNames"], [], "target ClawHub roster");
    const { packages, impactedPackageNames } = roster;
    const gitRoster = computeTargetClawHubRosterAudit(
      options.cwd,
      options.targetSha,
      options.policy.release.version,
    );
    const targetRoster = validateClawHubRoster(
      packages,
      options.targetSha,
      options.policy.release.version,
      "target ClawHub repo-native roster",
    );
    assert(
      stableJson(targetRoster) === stableJson(gitRoster),
      "target ClawHub repo-native and git rosters differ",
    );
    uniqueStrings(impactedPackageNames, "target ClawHub impacted package names", {
      allowEmpty: true,
    });
    const rosterNameSet = new Set(packages.map((entry) => entry.packageName));
    assert(
      impactedPackageNames.every((packageName) => rosterNameSet.has(packageName)) &&
        JSON.stringify(impactedPackageNames) ===
          JSON.stringify([...impactedPackageNames].toSorted()),
      "target ClawHub impacted package names are invalid",
    );
    const expectedEntries = [
      ...options.policy.clawHub.reused.map((entry) => ({ ...entry, mode: "reused" })),
      ...options.policy.clawHub.fresh.map((entry) => ({ ...entry, mode: "fresh" })),
    ];
    const rosterNames = packages.map((entry) => entry.packageName).toSorted();
    const policyNames = expectedEntries.map((entry) => entry.name).toSorted();
    assert(
      JSON.stringify(rosterNames) === JSON.stringify(policyNames),
      "ClawHub policy partition differs from the target publishable roster",
    );
    const freshNames = new Set(options.policy.clawHub.fresh.map((entry) => entry.name));
    assert(
      impactedPackageNames.every((packageName) => freshNames.has(packageName)),
      "ClawHub policy reuses evidence for an impacted package",
    );
    const packageEvidence = [];
    for (const entry of expectedEntries) {
      const role = roleMap.get(entry.role);
      assert(role?.mode === entry.mode, `ClawHub role ${entry.role} has the wrong evidence mode`);
      const version = packages.find((candidate) => candidate.packageName === entry.name)?.version;
      const base = clawHubArtifactBase(entry.name, version);
      const artifactsByKey = new Map(role.artifacts.map((artifact) => [artifact.key, artifact]));
      assert(
        artifactsByKey.size === 3 &&
          artifactsByKey.get("package")?.name === base &&
          artifactsByKey.get("inspector")?.name === `${base}-inspector` &&
          artifactsByKey.get("publish-json")?.name === `${base}-publish-json`,
        `ClawHub role ${entry.role} lacks the package/inspector/publish-json artifact triple`,
      );
      const packageArtifactEvidence = artifactsByKey.get("package");
      const packageFile = packageArtifactEvidence.files[0];
      const runArtifacts = await resolver.fetchArtifacts(role.run.id);
      const packageArtifact = runArtifacts.find(
        (artifact) => artifact.id === packageArtifactEvidence.id,
      );
      assert(packageArtifact, `ClawHub role ${entry.role} package artifact is missing`);
      const packageManifest = await readClawHubPackageManifest(
        await resolver.fetchArtifactBytes(packageArtifact, packageFile.path),
        `ClawHub role ${entry.role} package`,
      );
      assert(
        packageManifest.name === entry.name &&
          packageManifest.version === version &&
          packageManifest.openclaw?.release?.publishToClawHub === true,
        `ClawHub role ${entry.role} package identity differs`,
      );
      const publishArtifactEvidence = artifactsByKey.get("publish-json");
      const publishArtifact = runArtifacts.find(
        (artifact) => artifact.id === publishArtifactEvidence.id,
      );
      assert(publishArtifact, `ClawHub role ${entry.role} publish artifact is missing`);
      const publishDocument = parseJson(
        await resolver.fetchArtifactBytes(publishArtifact, "package-publish.json"),
        `ClawHub role ${entry.role} publish JSON`,
      );
      validateClawHubPublishDocument(
        publishDocument,
        {
          packageName: entry.name,
          version,
          commit: entry.mode === "reused" ? options.policy.git.sourceSha : options.targetSha,
        },
        `ClawHub role ${entry.role} publish JSON`,
      );
      packageEvidence.push({
        packageName: entry.name,
        role: entry.role,
        mode: entry.mode,
        version,
        artifactIds: role.artifacts.map((artifact) => artifact.id),
        packageTarball: {
          path: packageFile.path,
          sha256: packageFile.sha256,
          size: packageFile.size,
        },
      });
    }
    return {
      ...targetRoster,
      impactedPackageNames,
      evidence: packageEvidence,
    };
  } finally {
    spawnSync("git", ["worktree", "remove", "--force", worktreeRoot], {
      cwd: options.cwd,
      stdio: "ignore",
    });
    await fs.rm(worktreeRoot, { recursive: true, force: true });
  }
}

async function cancelledAggregateEvidence(policy, resolver, roleMap, evidenceRuns) {
  const contract = policy.cancelledAggregate;
  const candidates = [];
  for (const runId of evidenceRuns[contract.input]) {
    const run = await resolver.fetchRun(runId);
    if (
      run?.id !== runId ||
      run.path !== contract.workflow ||
      run.event !== contract.run.event ||
      run.head_branch !== contract.run.headBranch ||
      run.status !== "completed" ||
      run.conclusion !== contract.run.conclusion ||
      run.run_attempt !== contract.run.attempt
    ) {
      continue;
    }
    const jobs = await resolver.fetchJobs(runId);
    const bindingJobs = jobs.filter(
      (job) =>
        job.name === contract.sourceBinding.jobName &&
        job.status === "completed" &&
        job.conclusion === "success",
    );
    if (bindingJobs.length !== 1) continue;
    const bindingLog = await resolver.fetchLog(bindingJobs[0].id);
    const bindingLine = `${contract.sourceBinding.marker}: ${
      contract.sourceBinding.prefix ?? ""
    }${policy.git.sourceSha}`;
    if (literalCount(bindingLog, bindingLine) !== 1) continue;
    candidates.push({
      run,
      jobs,
      sourceBinding: {
        job: jobRecord(bindingJobs[0]),
        line: bindingLine,
        sha256: sha256(bindingLog),
      },
    });
  }
  assert(candidates.length === 1, `cancelled aggregate resolved ${candidates.length} candidates`);
  const [{ run, jobs, sourceBinding }] = candidates;
  resolver.usedRunIds.add(run.id);
  assert(
    jobs.length > 0 &&
      jobs.every(
        (job) =>
          job.status === "completed" &&
          ["success", "skipped", "failure", "cancelled"].includes(job.conclusion),
      ),
    "cancelled aggregate contains an incomplete or unsupported job conclusion",
  );
  const completedJobSet = validateCompletedJobSet(jobs, contract.completedJobs);
  const successful = jobs
    .filter((job) => job.conclusion === "success")
    .toSorted((left, right) => left.id - right.id);
  const successfulJobSet = validateSuccessfulJobSet(successful, contract.successfulJobs);
  const skipped = jobs
    .filter((job) => job.conclusion === "skipped")
    .toSorted((left, right) => left.id - right.id);
  const skippedJobSet = validateJobNameSet(skipped, contract.skippedJobs, "skipped", {
    allowEmpty: true,
  });
  const dispositions = contract.dispositions.map((entry) => {
    const matches = jobs.filter(
      (job) =>
        job.name === entry.name &&
        job.status === "completed" &&
        job.conclusion === entry.conclusion,
    );
    assert(matches.length === 1, `cancelled aggregate disposition ${entry.name} differs`);
    assert(
      entry.resolution.roles.every((roleId) => roleMap.get(roleId)?.conclusion === "success"),
      `cancelled aggregate disposition ${entry.name} has unresolved roles`,
    );
    return { ...entry, job: jobRecord(matches[0]) };
  });
  const unresolved = jobs.filter((job) => ["failure", "cancelled"].includes(job.conclusion));
  assert(
    unresolved.length === dispositions.length &&
      unresolved.every((job) =>
        dispositions.some(
          (entry) => entry.name === job.name && entry.conclusion === job.conclusion,
        ),
      ),
    "cancelled aggregate has undeclared failed or cancelled jobs",
  );
  return {
    run: runRecord(run),
    sourceBinding,
    completedJobs: completedJobSet.count,
    completedJobNamesAndConclusionsSha256: completedJobSet.namesAndConclusionsSha256,
    successfulJobs: successfulJobSet.count,
    successfulJobNamesSha256: successfulJobSet.namesSha256,
    skippedJobs: skippedJobSet.count,
    skippedJobNamesSha256: skippedJobSet.namesSha256,
    dispositions,
    conclusion: "success",
  };
}

export async function resolveRemoteTagState(tag, targetSha, deps) {
  const direct = await deps.apiOptional(
    `repos/${deps.repo}/git/ref/tags/${encodeURIComponent(tag)}`,
  );
  if (!direct) return { state: "absent" };
  let object = direct.object;
  const tagObjects = [];
  while (object?.type === "tag") {
    const annotated = await deps.api(`repos/${deps.repo}/git/tags/${object.sha}`);
    tagObjects.push(object.sha);
    object = annotated.object;
    assert(tagObjects.length < 8, "remote tag chain is unexpectedly deep");
  }
  assert(
    object?.type === "commit" && SHA_RE.test(object.sha ?? ""),
    "remote tag does not peel to a commit",
  );
  return {
    state: object.sha === targetSha ? "exact" : "stale",
    refSha: direct.object.sha,
    peeledSha: object.sha,
    tagObjects,
  };
}

function validateManifestShape(manifest, policy) {
  exactObject(
    manifest,
    [
      "schemaVersion",
      "kind",
      "mode",
      "version",
      "releaseTag",
      "targetRef",
      "policy",
      "sourceSha",
      "parentSha",
      "targetSha",
      "changedPaths",
      "touchedPaths",
      "commitPathAudit",
      "runtimeTree",
      "trustBundle",
      "tagState",
      "packageEvidence",
      "gateInventory",
      "clawHubAudit",
      "cancelledAggregate",
      "freshChecks",
      "releaseNotesLedger",
      "producer",
      "conclusion",
    ],
    [],
    "manifest",
  );
  assert(
    manifest.schemaVersion === 3 &&
      manifest.kind === KIND &&
      manifest.mode === MODE &&
      manifest.version === policy.release.version &&
      manifest.releaseTag === policy.release.tag &&
      manifest.targetRef === policy.release.targetRef &&
      manifest.sourceSha === policy.git.sourceSha &&
      manifest.conclusion === "success",
    "manifest identity differs from policy",
  );
  validSha(manifest.parentSha, "manifest.parentSha");
  validSha(manifest.targetSha, "manifest.targetSha");
  uniqueStrings(manifest.changedPaths, "manifest.changedPaths");
  uniqueStrings(manifest.touchedPaths, "manifest.touchedPaths");
  assert(
    Array.isArray(manifest.commitPathAudit) &&
      manifest.commitPathAudit.length > 0 &&
      manifest.commitPathAudit.at(-1)?.sha === manifest.targetSha &&
      manifest.commitPathAudit.at(-1)?.parent === manifest.parentSha,
    "manifest commit path audit does not bind the target parent",
  );
  exactObject(manifest.policy, ["path", "blobSha", "sha256"], [], "manifest.policy");
  validPath(manifest.policy.path, "manifest.policy.path");
  validSha(manifest.policy.blobSha, "manifest.policy.blobSha");
  validSha256(manifest.policy.sha256, "manifest.policy.sha256");
  assert(Array.isArray(manifest.gateInventory), "manifest.gateInventory must be an array");
  assert(
    JSON.stringify(manifest.gateInventory.map((entry) => entry.id)) ===
      JSON.stringify(policy.roles.map((entry) => entry.id)),
    "manifest gate inventory differs from policy",
  );
  assert(
    manifest.gateInventory.every((entry) => entry.conclusion === "success"),
    "manifest contains a failed role",
  );
  exactObject(
    manifest.clawHubAudit,
    [
      "schemaVersion",
      "targetSha",
      "packages",
      "manifestSha256",
      "impactedPackageNames",
      "evidence",
    ],
    [],
    "manifest.clawHubAudit",
  );
  const rosterAudit = validateClawHubRoster(
    manifest.clawHubAudit.packages,
    manifest.targetSha,
    policy.release.version,
    "manifest ClawHub roster",
  );
  const policyRoster = [
    ...policy.clawHub.reused.map((entry) => entry.name),
    ...policy.clawHub.fresh.map((entry) => entry.name),
  ].toSorted();
  assert(
    manifest.clawHubAudit.schemaVersion === 1 &&
      manifest.clawHubAudit.targetSha === manifest.targetSha &&
      manifest.clawHubAudit.manifestSha256 === rosterAudit.manifestSha256 &&
      JSON.stringify(
        manifest.clawHubAudit.packages.map((entry) => entry.packageName).toSorted(),
      ) === JSON.stringify(policyRoster),
    "manifest ClawHub audit differs from its target or policy roster",
  );
  assert(
    manifest.packageEvidence?.target?.artifact?.id > 0,
    "manifest lacks promotable npm artifact",
  );
  assert(
    DIGEST_RE.test(manifest.packageEvidence.target.artifact.digest ?? ""),
    "promotable npm artifact digest is invalid",
  );
  return manifest;
}

export function validateReleaseDeltaManifest(manifest, policy, expected = {}) {
  validateManifestShape(manifest, policy);
  for (const [key, value] of Object.entries(expected)) {
    if (value !== undefined) assert(manifest[key] === value, `manifest.${key} does not match`);
  }
  return manifest;
}

export async function createReleaseDeltaEvidence(options, deps) {
  const policy = parseReleaseDeltaPolicy(options.policy);
  validateReleaseDeltaPolicyPath(options.policyPath);
  assert(options.targetRef === policy.release.targetRef, "target ref differs from policy");
  assert(
    options.producer?.runAttempt === 1 &&
      options.producer.ref === "refs/heads/main" &&
      options.producer.workflowSha === options.workflowSha,
    "producer must be trusted-main attempt 1",
  );
  const packageJson = parseJson(
    git(options.cwd, ["show", `${options.targetSha}:package.json`]),
    "target package",
  );
  assert(
    packageJson.version === policy.release.version,
    "target package version differs from policy",
  );
  const delta = validateReleaseDelta(options.cwd, policy, options.targetSha);
  const evidenceRuns = parseEvidenceRuns(options.evidenceRuns, policy);
  const context = {
    baselineSha: policy.git.baselineSha,
    sourceSha: policy.git.sourceSha,
    parentSha: delta.parentSha,
    targetSha: options.targetSha,
    version: policy.release.version,
    tag: policy.release.tag,
  };
  const common = { ...options, policy, delta };
  const resolver = createReleaseDeltaResolver(common, deps, evidenceRuns);
  const roleMap = new Map();

  const packageContracts = policy.packageEquivalence;
  const roleById = new Map(policy.roles.map((role) => [role.id, role]));
  for (const roleId of [packageContracts.targetRole, packageContracts.sourceRole]) {
    const evidence = await resolver.resolveRole(roleById.get(roleId), context);
    roleMap.set(roleId, evidence);
  }
  const [sourcePackage, targetPackage] = await Promise.all([
    npmPackage(
      roleMap.get(packageContracts.sourceRole),
      policy.git.sourceSha,
      context,
      resolver,
      "source",
    ),
    npmPackage(
      roleMap.get(packageContracts.targetRole),
      options.targetSha,
      context,
      resolver,
      "target",
    ),
  ]);
  const packageEvidence = await comparePackages(common, sourcePackage, targetPackage);
  Object.assign(context, {
    targetNpmRunId: packageEvidence.target.run.id,
    targetNpmArtifactId: packageEvidence.target.artifact.id,
    targetNpmArtifactName: packageEvidence.target.artifact.name,
    targetNpmArtifactDigest: packageEvidence.target.artifact.digest,
    targetRootName: packageEvidence.target.root.name,
    targetRootSha256: packageEvidence.target.root.sha256,
    targetAiName: packageEvidence.target.ai.name,
    targetAiSha256: packageEvidence.target.ai.sha256,
  });

  for (const role of policy.roles) {
    if (roleMap.has(role.id)) continue;
    const evidence = await resolver.resolveRole(role, context);
    roleMap.set(role.id, evidence);
  }
  const telegram = await validateTelegramConsumption(
    roleMap.get(packageContracts.telegramRole),
    packageEvidence,
    resolver,
    context,
  );
  packageEvidence.telegram = telegram;
  const clawHubAudit = await targetClawHubAudit(common, roleMap, resolver);

  const cancelledAggregate = await cancelledAggregateEvidence(
    policy,
    resolver,
    roleMap,
    evidenceRuns,
  );
  const allDeclaredRunIds = Object.values(evidenceRuns).flat();
  assert(
    allDeclaredRunIds.every((runId) => resolver.usedRunIds.has(runId)),
    "evidence runs contain undeclared or unused runs",
  );
  const ledger = parseJson(options.releaseNotesVerification, "release notes ledger");
  assert(
    ledger.schemaVersion === policy.ledger.adapterSchemaVersion,
    "release notes ledger adapter version differs",
  );
  checkAssertions(ledger, policy.ledger.assertions, context, "release notes ledger");
  const ledgerBytes = Buffer.from(`${JSON.stringify(ledger, null, 2)}\n`);

  const [commit, ref, tagState] = await Promise.all([
    deps.api(`repos/${deps.repo}/commits/${options.targetSha}`),
    deps.api(`repos/${deps.repo}/git/ref/heads/${options.targetRef}`),
    resolveRemoteTagState(policy.release.tag, options.targetSha, deps),
  ]);
  assert(
    commit.sha === options.targetSha && commit.commit?.verification?.verified === true,
    "target commit signature is not verified",
  );
  assert(ref.object?.sha === options.targetSha, "release branch does not resolve to target");
  const changelog = git(options.cwd, ["show", `${options.targetSha}:CHANGELOG.md`], "buffer");
  const releaseNotes = renderGithubReleaseNotes({
    changelog: changelog.toString("utf8"),
    version: policy.release.version.replace(/-beta\.\d+$/u, ""),
    tag: policy.release.tag,
    repository: deps.repo,
  }).body;
  const policyBlob = gitBlob(options.cwd, options.workflowSha, options.policyPath);
  assert(
    sha256(policyBlob.bytes) === options.policySha256,
    "checked-in policy blob differs from the policy used for creation",
  );
  const manifest = {
    schemaVersion: 3,
    kind: KIND,
    mode: MODE,
    version: policy.release.version,
    releaseTag: policy.release.tag,
    targetRef: policy.release.targetRef,
    policy: {
      path: options.policyPath,
      blobSha: policyBlob.blobSha,
      sha256: options.policySha256,
    },
    sourceSha: policy.git.sourceSha,
    parentSha: delta.parentSha,
    targetSha: options.targetSha,
    changedPaths: delta.changedPaths,
    touchedPaths: delta.touchedPaths,
    commitPathAudit: delta.commitPathAudit,
    runtimeTree: delta.runtimeTree,
    trustBundle: computeTrustBundle(options.cwd, policy, options.workflowSha),
    tagState,
    packageEvidence,
    gateInventory: policy.roles.map((role) => roleMap.get(role.id)),
    clawHubAudit,
    cancelledAggregate,
    freshChecks: [
      { id: "delta-shape", commitCount: delta.commitPathAudit.length, conclusion: "success" },
      {
        id: "changed-tree-audit",
        changedPaths: delta.changedPaths,
        excludedMetadataPaths: policy.git.metadataPaths,
        productTreeChanged: !delta.runtimeTree.equivalent,
        reuseDecisionSource: "gateInventory[].impactPatterns and impactedPaths",
        sourceSha256: delta.runtimeTree.sourceSha256,
        targetSha256: delta.runtimeTree.targetSha256,
        conclusion: "success",
      },
      {
        id: "package-artifact-validation",
        rootValidationMode: policy.packageEquivalence.rules.rootPackageComparison,
        aiValidationMode: policy.packageEquivalence.rules.aiPackageComparison,
        targetRootSha256: packageEvidence.target.root.sha256,
        targetAiSha256: packageEvidence.target.ai.sha256,
        conclusion: "success",
      },
      { id: "changelog", sha256: sha256(changelog), conclusion: "success" },
      { id: "release-notes", sha256: sha256(releaseNotes), conclusion: "success" },
      { id: "contribution-ledger", sha256: sha256(ledgerBytes), conclusion: "success" },
      { id: "commit-signature", reason: commit.commit.verification.reason, conclusion: "success" },
      {
        id: "ref-integrity",
        ref: options.targetRef,
        sha: options.targetSha,
        conclusion: "success",
      },
    ],
    releaseNotesLedger: {
      schemaVersion: policy.ledger.adapterSchemaVersion,
      sha256: sha256(ledgerBytes),
      manifest: ledger,
    },
    producer: options.producer,
    conclusion: "success",
  };
  return validateReleaseDeltaManifest(manifest, policy);
}
