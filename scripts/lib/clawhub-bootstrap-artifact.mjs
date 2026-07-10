#!/usr/bin/env node

import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import {
  readBoundedRegularFile,
  readPublicationArtifactArchive,
} from "./actions-artifact-archive.mjs";
import {
  CLAWHUB_PUBLICATION_TAR_LIMITS,
  inspectPackageTarballBytes,
  validatePluginPackageManifest,
} from "../plugin-publication-artifact.mjs";

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const COMMIT_PATTERN = /^[a-f0-9]{40}$/u;
const POSITIVE_INTEGER_PATTERN = /^[1-9][0-9]*$/u;
const PACKAGE_NAME_PATTERN = /^@openclaw\/[a-z0-9][a-z0-9._-]*$/u;
const PACKAGE_DIR_PATTERN = /^extensions\/[a-z0-9][a-z0-9._-]*$/u;
const TAG_PATTERN = /^[a-z0-9][a-z0-9._-]*$/u;
const MAX_BOOTSTRAP_ARCHIVE_BYTES = 256 * 1024 * 1024;
const MAX_BOOTSTRAP_ARCHIVE_FILES = 128;
const MAX_BOOTSTRAP_MANIFEST_BYTES = 2 * 1024 * 1024;
// The compressed and total-payload limits match ClawHub's ClawPack contract.
// The expanded TAR and entry-count ceilings bound this credential-job parser.
const MAX_CLAWPACK_BYTES = CLAWHUB_PUBLICATION_TAR_LIMITS.maxArchiveBytes;

function fail(message) {
  throw new Error(message);
}

function requireString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    fail(`${label} is required.`);
  }
  return value.trim();
}

function requirePattern(value, pattern, label) {
  const result = requireString(value, label);
  if (!pattern.test(result)) {
    fail(`${label} is invalid.`);
  }
  return result;
}

function requireBoolean(value, label) {
  if (typeof value !== "boolean") {
    fail(`${label} must be a boolean.`);
  }
  return value;
}

function parsePlugins(value) {
  const plugins = requireString(value, "plugins")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  const unique = [...new Set(plugins)].toSorted((a, b) => a.localeCompare(b));
  if (unique.length !== plugins.length) {
    fail("plugins must not contain duplicates.");
  }
  for (const plugin of unique) {
    requirePattern(plugin, PACKAGE_NAME_PATTERN, `plugin ${plugin}`);
  }
  return unique;
}

function packageSlug(packageName) {
  return packageName.slice("@openclaw/".length);
}

function normalizePlanEntry(value, index) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`matrix[${index}] must be an object.`);
  }
  const packageName = requirePattern(
    value.packageName,
    PACKAGE_NAME_PATTERN,
    `matrix[${index}].packageName`,
  );
  const packageDir = requirePattern(
    value.packageDir,
    PACKAGE_DIR_PATTERN,
    `matrix[${index}].packageDir`,
  );
  const publishTag = requirePattern(value.publishTag, TAG_PATTERN, `matrix[${index}].publishTag`);
  const version = requireString(value.version, `matrix[${index}].version`);
  const bootstrapMode = requireString(value.bootstrapMode, `matrix[${index}].bootstrapMode`);
  if (bootstrapMode !== "publish" && bootstrapMode !== "configure-only") {
    fail(`matrix[${index}].bootstrapMode is invalid.`);
  }
  const requiresManualOverride = requireBoolean(
    value.requiresManualOverride,
    `matrix[${index}].requiresManualOverride`,
  );
  if (bootstrapMode === "configure-only" && !requiresManualOverride) {
    fail(`matrix[${index}] configure-only entries must require the manual override.`);
  }
  return {
    packageName,
    version,
    packageDir,
    publishTag,
    bootstrapMode,
    requiresManualOverride,
  };
}

function hashBytes(bytes) {
  return {
    sha256: createHash("sha256").update(bytes).digest("hex"),
    size: bytes.byteLength,
  };
}

async function hashFile(path) {
  return hashBytes(
    readBoundedRegularFile(path, {
      label: "Packed ClawHub artifact",
      maxBytes: MAX_CLAWPACK_BYTES,
    }),
  );
}

export async function verifyClawHubPackedArtifactIdentity(options) {
  const artifactPath = resolve(requireString(options.artifactPath, "artifactPath"));
  const expectedSha256 = requirePattern(options.expectedSha256, SHA256_PATTERN, "expectedSha256");
  const expectedSize = requirePattern(
    options.expectedSize,
    POSITIVE_INTEGER_PATTERN,
    "expectedSize",
  );
  const expectedName = requirePattern(options.expectedName, PACKAGE_NAME_PATTERN, "expectedName");
  const expectedVersion = requireString(options.expectedVersion, "expectedVersion");
  const expectedDir = requirePattern(options.expectedDir, PACKAGE_DIR_PATTERN, "expectedDir");

  const artifactStat = await lstat(artifactPath);
  if (!artifactStat.isFile() || artifactStat.isSymbolicLink()) {
    fail("Packed ClawHub artifact must be a regular file.");
  }
  if (artifactStat.size > MAX_CLAWPACK_BYTES) {
    fail(`Packed ClawHub artifact exceeds ${MAX_CLAWPACK_BYTES} bytes.`);
  }
  if (String(artifactStat.size) !== expectedSize) {
    fail("Packed ClawHub artifact hash or size mismatch.");
  }
  const bytes = readBoundedRegularFile(artifactPath, {
    label: "Packed ClawHub artifact",
    maxBytes: MAX_CLAWPACK_BYTES,
  });
  const identity = hashBytes(bytes);
  if (identity.sha256 !== expectedSha256 || String(identity.size) !== expectedSize) {
    fail("Packed ClawHub artifact hash or size mismatch.");
  }

  const inspection = inspectPackageTarballBytes(bytes, CLAWHUB_PUBLICATION_TAR_LIMITS);
  validatePluginPackageManifest(
    {
      packageDir: expectedDir,
      packageName: expectedName,
      route: "clawhub-token-bootstrap",
      version: expectedVersion,
    },
    inspection.packageManifest,
  );
  const packageName = inspection.packageManifest.name;
  const packageVersion = inspection.packageManifest.version;
  return { ...identity, packageName, packageVersion };
}

async function listFiles(root) {
  const result = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        fail(`Artifact inventory contains a symlink: ${relative(root, path)}`);
      }
      if (entry.isDirectory()) {
        await visit(path);
      } else if (entry.isFile()) {
        result.push(relative(root, path).split(sep).join("/"));
      } else {
        fail(`Artifact inventory contains a non-regular entry: ${relative(root, path)}`);
      }
    }
  }
  await visit(root);
  return result.toSorted((a, b) => a.localeCompare(b));
}

function readPositiveInteger(value, label) {
  const raw = requirePattern(value, POSITIVE_INTEGER_PATTERN, label);
  const result = Number(raw);
  if (!Number.isSafeInteger(result)) {
    fail(`${label} is outside the supported range.`);
  }
  return result;
}

function validateBootstrapArchiveInventory(files) {
  const manifestBytes = files.get("manifest.json");
  if (!manifestBytes || manifestBytes.byteLength > MAX_BOOTSTRAP_MANIFEST_BYTES) {
    fail("Bootstrap Actions artifact must contain one bounded manifest.json.");
  }
  let manifest;
  try {
    manifest = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes));
  } catch {
    fail("Bootstrap Actions artifact manifest.json is invalid JSON.");
  }
  if (!manifest || typeof manifest !== "object" || !Array.isArray(manifest.entries)) {
    fail("Bootstrap Actions artifact manifest.json has an invalid shape.");
  }
  const expected = new Set(["manifest.json"]);
  for (const entry of manifest.entries) {
    const artifactPath =
      entry && typeof entry === "object" ? requireString(entry.artifactPath, "artifactPath") : "";
    if (!/^packages\/[a-z0-9][a-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*\.tgz$/u.test(artifactPath)) {
      fail(`Bootstrap Actions artifact path is invalid: ${artifactPath}`);
    }
    if (expected.has(artifactPath)) {
      fail(`Bootstrap Actions artifact path is duplicated: ${artifactPath}`);
    }
    expected.add(artifactPath);
  }
  const actual = new Set(files.keys());
  if (
    actual.size !== expected.size ||
    [...actual].some((path) => !expected.has(path))
  ) {
    fail(
      `Bootstrap Actions artifact inventory mismatch: expected ${[...expected].toSorted().join(",")}, found ${[...actual].toSorted().join(",")}.`,
    );
  }
}

export async function downloadClawHubBootstrapArtifact(options) {
  const artifactId = readPositiveInteger(options.artifactId, "artifactId");
  const artifactSizeBytes = readPositiveInteger(options.artifactSize, "artifactSize");
  const runId = readPositiveInteger(options.runId, "runId");
  const runAttempt = readPositiveInteger(options.runAttempt, "runAttempt");
  const targetSha = requirePattern(options.targetSha, COMMIT_PATTERN, "targetSha");
  const workflowSha = requirePattern(options.workflowSha, COMMIT_PATTERN, "workflowSha");
  const artifactDigest = requirePattern(
    options.artifactDigest,
    SHA256_PATTERN,
    "artifactDigest",
  );
  const artifactName = requireString(options.artifactName, "artifactName");
  const expectedName = `clawhub-bootstrap-${targetSha.slice(0, 12)}-${runId}-${runAttempt}`;
  if (artifactName !== expectedName) {
    fail("ClawHub bootstrap artifact name does not bind the target and producer attempt.");
  }
  const outputRoot = resolve(requireString(options.outputRoot, "outputRoot"));
  await mkdir(outputRoot, { mode: 0o700, recursive: true });
  if ((await readdir(outputRoot)).length !== 0) {
    fail("ClawHub bootstrap artifact output directory must be empty.");
  }

  const result = await readPublicationArtifactArchive({
    archivePolicy: {
      minEntries: 2,
      maxEntries: MAX_BOOTSTRAP_ARCHIVE_FILES,
      maxArchiveBytes: MAX_BOOTSTRAP_ARCHIVE_BYTES,
      maxExpandedBytes: MAX_BOOTSTRAP_ARCHIVE_BYTES,
      allowPath: (path) =>
        path === "manifest.json" ||
        /^packages\/[a-z0-9][a-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*\.tgz$/u.test(path),
      maxCompressedEntryBytes: (path) =>
        path === "manifest.json" ? MAX_BOOTSTRAP_MANIFEST_BYTES : MAX_CLAWPACK_BYTES,
      maxEntryBytes: (path) =>
        path === "manifest.json" ? MAX_BOOTSTRAP_MANIFEST_BYTES : MAX_CLAWPACK_BYTES,
    },
    expected: {
      artifactDigest: `sha256:${artifactDigest}`,
      artifactId,
      artifactName,
      artifactSizeBytes,
      repository: requireString(options.repository, "repository"),
      runStatePolicy: "same-run-in-progress",
      runAttempt,
      runId,
      workflowEvent: "workflow_dispatch",
      workflowHeadBranch: "main",
      workflowPath: ".github/workflows/plugin-clawhub-new.yml",
      workflowSha,
    },
    maxArchiveBytes: MAX_BOOTSTRAP_ARCHIVE_BYTES,
    token: requireString(options.token, "token"),
  });
  validateBootstrapArchiveInventory(result.files);
  for (const [path, bytes] of result.files) {
    const destination = join(outputRoot, path);
    await mkdir(dirname(destination), { mode: 0o700, recursive: true });
    await writeFile(destination, bytes, { flag: "wx", mode: 0o600 });
  }
  return {
    artifactDigest,
    artifactId,
    artifactName,
    artifactSizeBytes,
    inventory: [...result.files.keys()].toSorted(),
    runAttempt,
    runId,
  };
}

async function resolveRegularArtifactFile(root, artifactPath) {
  if (
    typeof artifactPath !== "string" ||
    artifactPath.startsWith("/") ||
    artifactPath.includes("\\") ||
    artifactPath.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    fail(`Unsafe artifact path: ${String(artifactPath)}`);
  }
  const rootReal = await realpath(root);
  const candidate = resolve(root, artifactPath);
  const candidateReal = await realpath(candidate);
  if (candidateReal !== rootReal && !candidateReal.startsWith(`${rootReal}${sep}`)) {
    fail(`Artifact path escapes the artifact root: ${artifactPath}`);
  }
  const fileStat = await lstat(candidate);
  if (!fileStat.isFile() || fileStat.isSymbolicLink()) {
    fail(`Artifact path is not a regular file: ${artifactPath}`);
  }
  return candidate;
}

function assertExactPackageSet(entries, expectedPlugins) {
  const actual = entries.map((entry) => entry.packageName).toSorted((a, b) => a.localeCompare(b));
  if (JSON.stringify(actual) !== JSON.stringify(expectedPlugins)) {
    fail(
      `Artifact package set does not match requested plugins: expected ${expectedPlugins.join(",")}, found ${actual.join(",")}.`,
    );
  }
}

export async function createClawHubBootstrapArtifactManifest(options) {
  const artifactRoot = resolve(options.artifactRoot);
  const matrix = JSON.parse(await readFile(options.matrixPath, "utf8"));
  if (!Array.isArray(matrix) || matrix.length === 0) {
    fail("matrix must be a non-empty array.");
  }
  const entries = matrix.map(normalizePlanEntry);
  const expectedPlugins = parsePlugins(options.plugins);
  if (new Set(entries.map((entry) => entry.packageName)).size !== entries.length) {
    fail("matrix must not contain duplicate package names.");
  }
  assertExactPackageSet(entries, expectedPlugins);

  const manifestEntries = [];
  for (const entry of entries.toSorted((a, b) => a.packageName.localeCompare(b.packageName))) {
    const packageDirectory = join(artifactRoot, "packages", packageSlug(entry.packageName));
    const files = (await readdir(packageDirectory)).filter((name) => name.endsWith(".tgz"));
    if (files.length !== 1) {
      fail(`${entry.packageName} must have exactly one packed .tgz artifact.`);
    }
    const artifactPath = `packages/${packageSlug(entry.packageName)}/${files[0]}`;
    const filePath = await resolveRegularArtifactFile(artifactRoot, artifactPath);
    const identity = await hashFile(filePath);
    manifestEntries.push({ ...entry, artifactPath, ...identity });
  }

  const manifest = {
    schemaVersion: 1,
    repository: requireString(options.repository, "repository"),
    targetSha: requirePattern(options.targetSha, COMMIT_PATTERN, "targetSha"),
    workflowSha: requirePattern(options.workflowSha, COMMIT_PATTERN, "workflowSha"),
    runId: requirePattern(options.runId, POSITIVE_INTEGER_PATTERN, "runId"),
    runAttempt: requirePattern(options.runAttempt, POSITIVE_INTEGER_PATTERN, "runAttempt"),
    artifactName: requireString(options.artifactName, "artifactName"),
    requestedPlugins: expectedPlugins,
    entries: manifestEntries,
  };
  await mkdir(dirname(options.outputPath), { recursive: true });
  await writeFile(options.outputPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return manifest;
}

export async function verifyClawHubBootstrapArtifactManifest(options) {
  const artifactRoot = resolve(options.artifactRoot);
  const manifest = JSON.parse(await readFile(options.manifestPath, "utf8"));
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    fail("Bootstrap artifact manifest must be an object.");
  }
  if (manifest.schemaVersion !== 1) {
    fail(`Unsupported bootstrap artifact manifest schema: ${String(manifest.schemaVersion)}.`);
  }
  const expected = {
    repository: requireString(options.repository, "repository"),
    targetSha: requirePattern(options.targetSha, COMMIT_PATTERN, "targetSha"),
    workflowSha: requirePattern(options.workflowSha, COMMIT_PATTERN, "workflowSha"),
    runId: requirePattern(options.runId, POSITIVE_INTEGER_PATTERN, "runId"),
    runAttempt: requirePattern(options.runAttempt, POSITIVE_INTEGER_PATTERN, "runAttempt"),
    artifactName: requireString(options.artifactName, "artifactName"),
  };
  for (const [key, value] of Object.entries(expected)) {
    if (manifest[key] !== value) {
      fail(`Bootstrap artifact manifest ${key} mismatch.`);
    }
  }

  const expectedPlugins = parsePlugins(options.plugins);
  if (!Array.isArray(manifest.requestedPlugins)) {
    fail("Bootstrap artifact manifest requestedPlugins must be an array.");
  }
  if (JSON.stringify(manifest.requestedPlugins) !== JSON.stringify(expectedPlugins)) {
    fail("Bootstrap artifact manifest requestedPlugins mismatch.");
  }
  if (!Array.isArray(manifest.entries) || manifest.entries.length === 0) {
    fail("Bootstrap artifact manifest entries must be a non-empty array.");
  }

  const entries = [];
  const allowedFiles = new Set([relative(artifactRoot, options.manifestPath).split(sep).join("/")]);
  for (const [index, rawEntry] of manifest.entries.entries()) {
    const entry = normalizePlanEntry(rawEntry, index);
    const artifactPath = requireString(rawEntry.artifactPath, `${entry.packageName}.artifactPath`);
    const expectedPrefix = `packages/${packageSlug(entry.packageName)}/`;
    if (
      artifactPath !== `${expectedPrefix}${basename(artifactPath)}` ||
      !artifactPath.endsWith(".tgz")
    ) {
      fail(`${entry.packageName} artifactPath is invalid.`);
    }
    const expectedSha = requirePattern(
      rawEntry.sha256,
      SHA256_PATTERN,
      `${entry.packageName}.sha256`,
    );
    if (!Number.isSafeInteger(rawEntry.size) || rawEntry.size <= 0) {
      fail(`${entry.packageName}.size must be a positive integer.`);
    }
    const filePath = await resolveRegularArtifactFile(artifactRoot, artifactPath);
    const identity = await hashFile(filePath);
    if (identity.sha256 !== expectedSha || identity.size !== rawEntry.size) {
      fail(`${entry.packageName} packed artifact hash or size mismatch.`);
    }
    allowedFiles.add(artifactPath);
    entries.push({ ...entry, artifactPath, ...identity });
  }
  if (new Set(entries.map((entry) => entry.packageName)).size !== entries.length) {
    fail("Bootstrap artifact manifest must not contain duplicate package names.");
  }
  assertExactPackageSet(entries, expectedPlugins);

  const inventory = await listFiles(artifactRoot);
  const expectedInventory = [...allowedFiles].toSorted((a, b) => a.localeCompare(b));
  if (JSON.stringify(inventory) !== JSON.stringify(expectedInventory)) {
    fail(
      `Bootstrap artifact inventory mismatch: expected ${expectedInventory.join(",")}, found ${inventory.join(",")}.`,
    );
  }
  return { ...manifest, entries };
}

function parseArgs(argv) {
  const values = [...argv];
  const command = values.shift();
  const result = { command };
  while (values.length > 0) {
    const key = values.shift();
    const value = values.shift();
    if (!key?.startsWith("--") || value === undefined) {
      fail(`Invalid argument: ${String(key)}`);
    }
    result[key.slice(2).replaceAll("-", "_")] = value;
  }
  return result;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.command === "download") {
    const result = await downloadClawHubBootstrapArtifact({
      artifactDigest: args.artifact_digest,
      artifactId: args.artifact_id,
      artifactName: args.artifact_name,
      artifactSize: args.artifact_size,
      outputRoot: args.output_root,
      repository: args.repository,
      runAttempt: args.run_attempt,
      runId: args.run_id,
      targetSha: args.target_sha,
      token: process.env.GH_TOKEN,
      workflowSha: args.workflow_sha,
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  if (args.command === "verify-packed") {
    const identity = await verifyClawHubPackedArtifactIdentity({
      artifactPath: args.path,
      expectedDir: args.expected_dir,
      expectedSha256: args.expected_sha256,
      expectedSize: args.expected_size,
      expectedName: args.expected_name,
      expectedVersion: args.expected_version,
    });
    process.stdout.write(`${JSON.stringify(identity)}\n`);
    return;
  }
  const common = {
    artifactRoot: args.artifact_root,
    artifactName: args.artifact_name,
    repository: args.repository,
    targetSha: args.target_sha,
    workflowSha: args.workflow_sha,
    runId: args.run_id,
    runAttempt: args.run_attempt,
    plugins: args.plugins,
  };
  if (args.command === "create") {
    await createClawHubBootstrapArtifactManifest({
      ...common,
      matrixPath: args.matrix,
      outputPath: args.output,
    });
    return;
  }
  if (args.command === "verify") {
    const manifest = await verifyClawHubBootstrapArtifactManifest({
      ...common,
      manifestPath: args.manifest,
    });
    if (args.output) {
      await mkdir(dirname(args.output), { recursive: true });
      await writeFile(args.output, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    } else {
      process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
    }
    return;
  }
  fail(
    "Usage: clawhub-bootstrap-artifact.mjs <create|download|verify|verify-packed> [options]",
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
