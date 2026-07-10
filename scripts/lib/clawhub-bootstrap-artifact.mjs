#!/usr/bin/env node

import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const COMMIT_PATTERN = /^[a-f0-9]{40}$/u;
const POSITIVE_INTEGER_PATTERN = /^[1-9][0-9]*$/u;
const PACKAGE_NAME_PATTERN = /^@openclaw\/[a-z0-9][a-z0-9._-]*$/u;
const PACKAGE_DIR_PATTERN = /^extensions\/[a-z0-9][a-z0-9._-]*$/u;
const TAG_PATTERN = /^[a-z0-9][a-z0-9._-]*$/u;
const TAR_BLOCK_SIZE = 512;
// The compressed and total-payload limits match ClawHub's ClawPack contract.
// The expanded TAR and entry-count ceilings bound this credential-job parser.
const MAX_CLAWPACK_BYTES = 120 * 1024 * 1024;
const MAX_EXPANDED_TAR_BYTES = 64 * 1024 * 1024;
const MAX_TOTAL_FILE_BYTES = 50 * 1024 * 1024;
const MAX_FILE_BYTES = MAX_TOTAL_FILE_BYTES;
const MAX_FILE_COUNT = 10_000;

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

function textFromBytes(bytes) {
  return new TextDecoder().decode(bytes);
}

// Match clawhub@0.23.1 path canonicalization before applying stricter
// duplicate-path rejection so the credential job cannot select ambiguous bytes.
function readTarString(block, offset, length) {
  const slice = block.subarray(offset, offset + length);
  const end = slice.indexOf(0);
  return textFromBytes(end === -1 ? slice : slice.subarray(0, end)).trim();
}

function readTarSize(block) {
  const raw = readTarString(block, 124, 12).split("\0").join("").trim();
  if (!raw) {
    return 0;
  }
  const size = Number.parseInt(raw, 8);
  if (!Number.isFinite(size) || size < 0) {
    fail("Invalid tar entry size.");
  }
  return size;
}

function normalizeTarPath(path) {
  const normalized = path.replaceAll("\\", "/").replace(/^\.\/+/u, "");
  if (!normalized || normalized.startsWith("/") || normalized.includes("\0")) {
    return undefined;
  }
  const segments = normalized.split("/").filter(Boolean);
  if (segments.length === 0 || segments.some((segment) => segment === "." || segment === "..")) {
    return undefined;
  }
  return segments.join("/");
}

function nextTarOffset(offset, size) {
  return offset + Math.ceil(size / TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE;
}

function parseClawHubPackedEntries(bytes) {
  let tarBytes;
  try {
    tarBytes = gunzipSync(bytes, { maxOutputLength: MAX_EXPANDED_TAR_BYTES });
  } catch (error) {
    if (error?.code === "ERR_BUFFER_TOO_LARGE") {
      fail(`ClawPack expands beyond ${MAX_EXPANDED_TAR_BYTES} bytes.`);
    }
    fail("ClawPack must be a gzip-compressed npm pack tarball.");
  }

  const entries = [];
  const paths = new Set();
  let totalFileBytes = 0;
  let tarEntryCount = 0;
  let offset = 0;
  while (offset + TAR_BLOCK_SIZE <= tarBytes.byteLength) {
    const header = tarBytes.subarray(offset, offset + TAR_BLOCK_SIZE);
    if (header.every((byte) => byte === 0)) {
      break;
    }
    tarEntryCount += 1;
    if (tarEntryCount > MAX_FILE_COUNT) {
      fail(`ClawPack contains more than ${MAX_FILE_COUNT} TAR entries.`);
    }

    const name = readTarString(header, 0, 100);
    const prefix = readTarString(header, 345, 155);
    const path = normalizeTarPath(prefix ? `${prefix}/${name}` : name);
    if (!path) {
      fail("ClawPack contains an unsafe tar path.");
    }

    const size = readTarSize(header);
    if (size > MAX_FILE_BYTES) {
      fail(`ClawPack entry ${path} exceeds ${MAX_FILE_BYTES} bytes.`);
    }
    const payloadOffset = offset + TAR_BLOCK_SIZE;
    const payloadEnd = payloadOffset + size;
    if (payloadEnd > tarBytes.byteLength) {
      fail("ClawPack tar entry is truncated.");
    }

    const typeflag = String.fromCharCode(header[156] ?? 0).replace("\0", "");
    if (typeflag === "" || typeflag === "0") {
      if (!path.startsWith("package/")) {
        fail("ClawPack entries must be rooted under package/.");
      }
      const relativePath = path.slice("package/".length);
      if (relativePath && !relativePath.endsWith("/")) {
        if (paths.has(relativePath)) {
          fail(`ClawPack contains duplicate normalized path: ${relativePath}.`);
        }
        const nextTotalFileBytes = totalFileBytes + size;
        if (nextTotalFileBytes > MAX_TOTAL_FILE_BYTES) {
          fail(`ClawPack file payload exceeds ${MAX_TOTAL_FILE_BYTES} bytes.`);
        }
        totalFileBytes = nextTotalFileBytes;
        paths.add(relativePath);
        entries.push({
          path: relativePath,
          bytes: Uint8Array.from(tarBytes.subarray(payloadOffset, payloadEnd)),
        });
      }
    } else if (typeflag !== "5") {
      fail("ClawPack may only contain regular files and directories.");
    }

    offset = nextTarOffset(payloadOffset, size);
  }

  if (entries.length === 0) {
    fail("ClawPack contains no files.");
  }
  return entries;
}

function parsePackedJson(entries, path, label) {
  const entry = entries.find((candidate) => candidate.path === path);
  if (!entry) {
    fail(`ClawPack must contain package/${path}.`);
  }
  let value;
  try {
    value = JSON.parse(textFromBytes(entry.bytes));
  } catch {
    fail(`ClawPack ${label} is invalid JSON.`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`ClawPack ${label} must be an object.`);
  }
  return value;
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
  return hashBytes(await readFile(path));
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
  const bytes = await readFile(artifactPath);
  if (bytes.byteLength > MAX_CLAWPACK_BYTES) {
    fail(`Packed ClawHub artifact exceeds ${MAX_CLAWPACK_BYTES} bytes.`);
  }
  const identity = hashBytes(bytes);
  if (identity.sha256 !== expectedSha256 || String(identity.size) !== expectedSize) {
    fail("Packed ClawHub artifact hash or size mismatch.");
  }

  const entries = parseClawHubPackedEntries(bytes);
  const packageJson = parsePackedJson(entries, "package.json", "package.json");
  parsePackedJson(entries, "openclaw.plugin.json", "openclaw.plugin.json");
  const packageName = typeof packageJson.name === "string" ? packageJson.name.trim() : "";
  const packageVersion = typeof packageJson.version === "string" ? packageJson.version.trim() : "";
  if (!packageName) {
    fail("ClawPack package.json must declare a name.");
  }
  if (!packageVersion) {
    fail("ClawPack package.json must declare a version.");
  }
  if (packageName !== expectedName || packageVersion !== expectedVersion) {
    fail(
      `Packed ClawHub identity mismatch: expected ${expectedName}@${expectedVersion}, found ${packageName}@${packageVersion}.`,
    );
  }
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
  if (args.command === "verify-packed") {
    const identity = await verifyClawHubPackedArtifactIdentity({
      artifactPath: args.path,
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
  fail("Usage: clawhub-bootstrap-artifact.mjs <create|verify|verify-packed> [options]");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
