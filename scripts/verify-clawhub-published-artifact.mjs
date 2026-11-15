#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readdirSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { readBoundedResponseBytes } from "./lib/bounded-response.mjs";
import {
  parseClawHubArtifactOptions,
  readClawHubBootstrapManifest,
} from "./lib/clawhub-bootstrap-artifact.mjs";
import { readBoundedRegularFile } from "./plugin-publication-artifact.mjs";

const DEFAULT_ATTEMPTS = 12;
const DEFAULT_DELAY_MS = 5_000;
const DEFAULT_ATTEMPT_TIMEOUT_MS = 120_000;
const MAX_ATTEMPTS = 12;
const MAX_DELAY_MS = 60_000;
const MAX_ARTIFACT_BYTES = 130 * 1024 * 1024;
const MAX_JSON_BYTES = 1024 * 1024;
const PACKAGE_NAME_PATTERN = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u;
const PACKAGE_VERSION_PATTERN =
  /^[0-9]{4}\.[1-9][0-9]*\.[1-9][0-9]*(?:-(?:alpha|beta)\.[1-9][0-9]*|-[1-9][0-9]*)?$/u;
const PUBLISH_TAG_PATTERN = /^(?:alpha|beta|latest)$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const SHA512_INTEGRITY_PATTERN = /^sha512-[A-Za-z0-9+/]{86}==$/u;
const TOOLCHAIN_VERSION_PATTERN = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u;

class RetryableReadbackError extends Error {
  constructor(message, requestedDelayMs) {
    super(message);
    this.retryAfterMs = requestedDelayMs;
  }
}

function fail(message) {
  throw new Error(message);
}

function positiveInteger(value, fallback, label, maximum = Number.MAX_SAFE_INTEGER) {
  const raw = value === undefined ? fallback : value;
  const text = raw === undefined ? "" : String(raw);
  if (!/^[1-9][0-9]*$/u.test(text)) {
    fail(`${label} must be an integer from 1 through ${maximum}.`);
  }
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > maximum) {
    fail(`${label} must be an integer from 1 through ${maximum}.`);
  }
  return parsed;
}

function requiredPattern(value, pattern, label) {
  if (typeof value !== "string" || !pattern.test(value)) {
    fail(`${label} is invalid.`);
  }
  return value;
}

function requiredString(value, label) {
  if (typeof value !== "string" || value.trim() !== value || value.length === 0) {
    fail(`${label} is invalid.`);
  }
  return value;
}

function retryAfterMs(headers) {
  const retryAfter = headers?.get("retry-after")?.trim();
  if (!retryAfter) {
    return undefined;
  }
  if (/^[0-9]+$/u.test(retryAfter)) {
    return Number(retryAfter) * 1_000;
  }
  const dateMs = Date.parse(retryAfter);
  if (Number.isFinite(dateMs)) {
    return Math.max(0, dateMs - Date.now());
  }
  return undefined;
}

function retryableStatus(status) {
  return [404, 408, 425, 429, 500, 502, 503, 504].includes(status);
}

async function cancelResponse(response) {
  await response.body?.cancel().catch(() => undefined);
}

async function fetchResponse(url, options, context) {
  const response = await context.fetchImpl(url, {
    ...options,
    redirect: "follow",
    signal: context.signal,
  });
  if (retryableStatus(response.status)) {
    const delay = retryAfterMs(response.headers);
    await cancelResponse(response);
    throw new RetryableReadbackError(`${url} returned HTTP ${response.status}.`, delay);
  }
  if (!response.ok) {
    await cancelResponse(response);
    throw new Error(`${url} returned HTTP ${response.status}.`);
  }
  return response;
}

async function fetchBoundedBody(url, options, context, maximumBytes) {
  try {
    const response = await fetchResponse(url, options, context);
    const bytes = await readBoundedResponseBytes(response, url, maximumBytes, {
      signal: context.signal,
    });
    if (!response.body) {
      throw new Error(`${url} returned no response body.`);
    }
    return { bytes, headers: response.headers };
  } catch (error) {
    if (error instanceof RetryableReadbackError) {
      throw error;
    }
    throw new Error(
      `${url} read failed: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

async function fetchJson(url, context) {
  const { bytes } = await fetchBoundedBody(
    url,
    { headers: { accept: "application/json" } },
    context,
    MAX_JSON_BYTES,
  );
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    throw new Error(
      `${url} returned invalid JSON: ${error instanceof Error ? error.message : String(error)}.`,
      { cause: error },
    );
  }
}

function requireObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} is missing or invalid.`);
  }
  return value;
}

function requireExact(value, expected, label) {
  if (value !== expected) {
    throw new Error(`${label} mismatch: expected ${String(expected)}, found ${String(value)}.`);
  }
}

function artifactIdentity(bytes) {
  return {
    sha256: createHash("sha256").update(bytes).digest("hex"),
    size: bytes.byteLength,
    npmIntegrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
    npmShasum: createHash("sha1").update(bytes).digest("hex"),
  };
}

function readExpectedPackageArtifact(directory) {
  const artifactDirectory = requiredString(directory, "expectedArtifactDir");
  const entries = readdirSync(artifactDirectory, { withFileTypes: true });
  if (entries.length !== 1 || !entries[0].isFile() || !entries[0].name.endsWith(".tgz")) {
    fail("Expected artifact directory must contain exactly one root .tgz regular file.");
  }
  const fileName = entries[0].name;
  const bytes = readBoundedRegularFile(join(artifactDirectory, fileName), {
    label: "Expected ClawHub package artifact",
    maxBytes: MAX_ARTIFACT_BYTES,
  });
  return { bytes, fileName };
}

function validateArtifactMetadata(entry, metadata, identity, headers) {
  const packageDetail = requireObject(metadata.package, `${entry.packageName} artifact package`);
  const artifact = requireObject(metadata.artifact, `${entry.packageName} artifact metadata`);
  requireExact(packageDetail.name, entry.packageName, `${entry.packageName} artifact package name`);
  requireExact(metadata.version, entry.version, `${entry.packageName} artifact version`);
  requireExact(artifact.kind, "npm-pack", `${entry.packageName} artifact kind`);
  for (const field of ["sha256", "size", "npmIntegrity", "npmShasum"]) {
    requireExact(artifact[field], identity[field], `${entry.packageName} artifact ${field}`);
  }
  for (const [header, field, label] of [
    ["x-clawhub-artifact-sha256", "sha256", "sha256"],
    ["x-clawhub-npm-integrity", "npmIntegrity", "npm integrity"],
    ["x-clawhub-npm-shasum", "npmShasum", "shasum"],
  ]) {
    requireExact(
      headers.get(header),
      identity[field],
      `${entry.packageName} download ${label} header`,
    );
  }
  return {
    kind: artifact.kind,
    sha256: artifact.sha256,
    size: artifact.size,
    npmIntegrity: artifact.npmIntegrity,
    npmShasum: artifact.npmShasum,
    packageName: packageDetail.name,
    version: metadata.version,
  };
}

async function verifyEntryOnce(entry, options, context) {
  const registry = options.registry;
  const encodedName = encodeURIComponent(entry.packageName);
  const encodedVersion = encodeURIComponent(entry.version);
  const detailUrl = `${registry}/api/v1/packages/${encodedName}`;
  const versionUrl = `${detailUrl}/versions/${encodedVersion}`;
  const metadataUrl = `${versionUrl}/artifact`;
  const artifactUrl = `${metadataUrl}/download`;

  const detail = await fetchJson(detailUrl, context);
  requireExact(
    detail?.package?.tags?.[entry.publishTag],
    entry.version,
    `${entry.packageName} ClawHub tag ${entry.publishTag}`,
  );
  if (options.mode === "postpublish") {
    const trustedPublisher = (await fetchJson(`${detailUrl}/trusted-publisher`, context))
      ?.trustedPublisher;
    for (const [field, expected, label] of [
      ["provider", "github-actions", "provider"],
      ["repository", "openclaw/openclaw", "repository"],
      ["workflowFilename", "plugin-clawhub-release.yml", "workflow"],
    ]) {
      requireExact(
        trustedPublisher?.[field],
        expected,
        `${entry.packageName} trusted publisher ${label}`,
      );
    }
    requireExact(
      trustedPublisher?.environment ?? null,
      null,
      `${entry.packageName} trusted publisher environment`,
    );
  }

  const metadata = await fetchJson(metadataUrl, context);
  const { bytes, headers } = await fetchBoundedBody(artifactUrl, {}, context, MAX_ARTIFACT_BYTES);
  const identity = artifactIdentity(bytes);
  requireExact(identity.sha256, entry.sha256, `${entry.packageName} registry artifact sha256`);
  requireExact(identity.size, entry.size, `${entry.packageName} registry artifact size`);
  const artifactMetadata = validateArtifactMetadata(entry, metadata, identity, headers);

  return {
    packageName: entry.packageName,
    version: entry.version,
    publishTag: entry.publishTag,
    bootstrapMode: entry.bootstrapMode,
    expectedSha256: entry.sha256,
    expectedSize: entry.size,
    registrySha256: identity.sha256,
    registrySize: identity.size,
    npmIntegrity: identity.npmIntegrity,
    npmShasum: identity.npmShasum,
    artifactMetadata,
  };
}

async function runBoundedRetry(label, operation, retryOptions = {}) {
  const attempts = positiveInteger(
    retryOptions.attempts,
    DEFAULT_ATTEMPTS,
    "attempts",
    MAX_ATTEMPTS,
  );
  const delayMs = positiveInteger(retryOptions.delayMs, DEFAULT_DELAY_MS, "delayMs", MAX_DELAY_MS);
  const timeoutMs = positiveInteger(
    retryOptions.timeoutMs,
    DEFAULT_ATTEMPT_TIMEOUT_MS,
    "timeoutMs",
  );
  const sleep =
    retryOptions.sleep ??
    ((milliseconds) =>
      new Promise((resolveDelay) => {
        setTimeout(resolveDelay, milliseconds);
      }));
  const fetchImpl = retryOptions.fetchImpl ?? fetch;
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const signal = AbortSignal.timeout(timeoutMs);
    try {
      return await operation({ fetchImpl, signal });
    } catch (error) {
      // Native fetch wraps socket and permanent TLS failures alike. Only typed
      // transport failures retry; completed content and identity failures do not.
      const transportError = error?.cause ?? error;
      const networkFailure =
        transportError?.name === "TimeoutError" ||
        [
          "ECONNRESET",
          "ECONNREFUSED",
          "ETIMEDOUT",
          "EAI_AGAIN",
          "UND_ERR_SOCKET",
          "UND_ERR_CONNECT_TIMEOUT",
          "UND_ERR_HEADERS_TIMEOUT",
          "UND_ERR_BODY_TIMEOUT",
        ].some((code) => code === transportError?.code || code === transportError?.cause?.code);
      if (!(error instanceof RetryableReadbackError) && !networkFailure) {
        throw new Error(
          `${label} readback failed: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }
      if ((error.retryAfterMs ?? 0) > MAX_DELAY_MS) {
        throw error;
      }
      lastError = error;
      if (attempt < attempts) {
        await sleep(Math.max(error.retryAfterMs ?? 0, Math.min(MAX_DELAY_MS, delayMs * attempt)));
      }
    }
  }

  const detail = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(
    `${label} did not stabilize after ${attempts} attempts; last failure ${detail}. Retry readback, not publication.`,
    { cause: lastError },
  );
}

export async function verifyPublishedClawHubArtifacts(options) {
  const registry = String(options.registry ?? "https://clawhub.ai").replace(/\/+$/u, "");
  const manifest = readClawHubBootstrapManifest(options.manifestPath);
  const expectedToolchain = {
    clawhubToolchainIntegrity: requiredPattern(
      options.clawhubToolchainIntegrity,
      SHA512_INTEGRITY_PATTERN,
      "clawhubToolchainIntegrity",
    ),
    clawhubToolchainSha256: requiredPattern(
      options.clawhubToolchainSha256,
      SHA256_PATTERN,
      "clawhubToolchainSha256",
    ),
    clawhubToolchainVersion: requiredPattern(
      options.clawhubToolchainVersion,
      TOOLCHAIN_VERSION_PATTERN,
      "clawhubToolchainVersion",
    ),
  };
  for (const [key, expected] of Object.entries(expectedToolchain)) {
    if (manifest[key] !== expected) {
      fail(`Validated ClawHub bootstrap manifest ${key} mismatch.`);
    }
  }
  const mode = options.mode ?? "postpublish";
  if (mode !== "postpublish" && mode !== "configure-only-preflight") {
    fail(`Unsupported ClawHub artifact verification mode: ${String(mode)}.`);
  }
  const producerRunAttempt = positiveInteger(manifest.runAttempt, undefined, "manifest runAttempt");
  const terminalRunAttempt = positiveInteger(
    options.terminalRunAttempt,
    undefined,
    "terminalRunAttempt",
  );
  if (terminalRunAttempt < producerRunAttempt) {
    fail("terminalRunAttempt must be greater than or equal to the producer run attempt.");
  }
  const artifactId = String(positiveInteger(options.artifactId, undefined, "artifactId"));
  const artifactDigest = requiredPattern(options.artifactDigest, SHA256_PATTERN, "artifactDigest");

  const entries =
    mode === "configure-only-preflight"
      ? manifest.entries.filter((entry) => entry.bootstrapMode === "configure-only")
      : manifest.entries;
  const results = [];
  for (const entry of entries) {
    results.push(
      await runBoundedRetry(
        `${entry.packageName}@${entry.version} ClawHub artifact`,
        (context) => verifyEntryOnce(entry, { registry, mode }, context),
        options.retryOptions,
      ),
    );
  }
  return {
    schemaVersion: 2,
    repository: manifest.repository,
    targetSha: manifest.targetSha,
    workflowSha: manifest.workflowSha,
    runId: manifest.runId,
    producerRunAttempt: String(producerRunAttempt),
    terminalRunAttempt: String(terminalRunAttempt),
    artifactName: manifest.artifactName,
    artifactId,
    artifactDigest,
    clawhubToolchainIntegrity: manifest.clawhubToolchainIntegrity,
    clawhubToolchainSha256: manifest.clawhubToolchainSha256,
    clawhubToolchainVersion: manifest.clawhubToolchainVersion,
    requestedPlugins: manifest.requestedPlugins,
    verificationMode: mode,
    packages: results,
  };
}

export async function verifyPublishedClawHubPackage(options) {
  const registry = String(options.registry ?? "https://clawhub.ai").replace(/\/+$/u, "");
  const packageName = requiredPattern(options.packageName, PACKAGE_NAME_PATTERN, "packageName");
  const version = requiredPattern(
    options.packageVersion,
    PACKAGE_VERSION_PATTERN,
    "packageVersion",
  );
  const publishTag = requiredPattern(options.publishTag, PUBLISH_TAG_PATTERN, "publishTag");
  const { bytes, fileName } = readExpectedPackageArtifact(options.expectedArtifactDir);
  const expected = artifactIdentity(bytes);
  const entry = {
    bootstrapMode: null,
    packageName,
    publishTag,
    sha256: expected.sha256,
    size: expected.size,
    version,
  };
  const result = await runBoundedRetry(
    `${packageName}@${version} ClawHub artifact`,
    (context) => verifyEntryOnce(entry, { registry, mode: "postpublish" }, context),
    options.retryOptions,
  );
  return {
    schemaVersion: 1,
    // Registry bytes and current publisher configuration do not attest the
    // actor or credential that originally published this version.
    verificationMode: "artifact-postpublish",
    publicationAuthentication: "not-verified",
    expectedArtifact: {
      fileName,
      ...expected,
    },
    package: result,
  };
}

async function main() {
  const args = parseClawHubArtifactOptions(process.argv.slice(2));
  const retryOptions = {
    attempts: positiveInteger(
      process.env.OPENCLAW_CLAWHUB_VERIFY_ATTEMPTS,
      DEFAULT_ATTEMPTS,
      "OPENCLAW_CLAWHUB_VERIFY_ATTEMPTS",
      MAX_ATTEMPTS,
    ),
    delayMs: positiveInteger(
      process.env.OPENCLAW_CLAWHUB_VERIFY_DELAY_MS,
      DEFAULT_DELAY_MS,
      "OPENCLAW_CLAWHUB_VERIFY_DELAY_MS",
      MAX_DELAY_MS,
    ),
    timeoutMs: positiveInteger(
      process.env.OPENCLAW_CLAWHUB_VERIFY_ATTEMPT_TIMEOUT_MS,
      DEFAULT_ATTEMPT_TIMEOUT_MS,
      "OPENCLAW_CLAWHUB_VERIFY_ATTEMPT_TIMEOUT_MS",
    ),
  };
  const directMode = [
    args.expected_artifact_dir,
    args.package_name,
    args.package_version,
    args.publish_tag,
  ].some((value) => value !== undefined);
  if (directMode && args.manifest !== undefined) {
    fail("Direct package verification and bootstrap manifest verification are mutually exclusive.");
  }
  if (!directMode && args.manifest === undefined) {
    fail("Expected --manifest or --expected-artifact-dir.");
  }
  const evidence = directMode
    ? await verifyPublishedClawHubPackage({
        expectedArtifactDir: args.expected_artifact_dir,
        packageName: args.package_name,
        packageVersion: args.package_version,
        publishTag: args.publish_tag,
        registry: args.registry,
        retryOptions,
      })
    : await verifyPublishedClawHubArtifacts({
        registry: args.registry,
        manifestPath: args.manifest,
        artifactId: args.artifact_id,
        artifactDigest: args.artifact_digest,
        clawhubToolchainIntegrity: args.clawhub_toolchain_integrity,
        clawhubToolchainSha256: args.clawhub_toolchain_sha256,
        clawhubToolchainVersion: args.clawhub_toolchain_version,
        mode: args.mode,
        terminalRunAttempt: args.terminal_run_attempt,
        retryOptions,
      });
  if (args.output) {
    await mkdir(dirname(args.output), { recursive: true });
    await writeFile(args.output, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  }
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
