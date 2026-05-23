#!/usr/bin/env node
// Normalizes package-acceptance inputs into the tarball shape consumed by Docker E2E.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lookup as dnsLookupCb } from "node:dns";
import { lookup as dnsLookup } from "node:dns/promises";
import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import { isIP } from "node:net";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { Agent } from "undici";

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_OUTPUT_NAME = "openclaw-current.tgz";
const PACKAGE_URL_DOWNLOAD_TIMEOUT_MS = 60_000;
const PACKAGE_URL_MAX_BYTES = 250 * 1024 * 1024;
const PACKAGE_URL_MAX_REDIRECTS = 5;
const TRUSTED_PACKAGE_SOURCE_POLICY = ".github/package-trusted-sources.json";
const TRUSTED_PACKAGE_SOURCE_TOKEN_ENV = "OPENCLAW_TRUSTED_PACKAGE_TOKEN";
const BLOCKED_PACKAGE_HOSTNAMES = new Set([
  "localhost",
  "localhost.localdomain",
  "metadata.google.internal",
]);
export const OPENCLAW_PACKAGE_SPEC_RE =
  /^openclaw@(alpha|beta|latest|[0-9]{4}\.[1-9][0-9]*\.[1-9][0-9]*(-[1-9][0-9]*|-(alpha|beta)\.[1-9][0-9]*)?)$/u;

function usage() {
  return `Usage: node scripts/resolve-openclaw-package-candidate.mjs --source <ref|npm|url|trusted-url|artifact> --output-dir <dir> [options]

Options:
  --package-spec <spec>       Published npm spec for source=npm.
  --package-ref <ref>         Trusted repo ref for source=ref.
  --package-url <url>         HTTPS tarball URL for source=url or source=trusted-url.
  --package-sha256 <sha256>   Expected tarball SHA-256 for source=url, source=trusted-url, or source=artifact.
  --trusted-source-id <id>    Named trusted URL policy for source=trusted-url.
  --trusted-source-policy <file>
                              Repo-controlled trusted URL source policy. Default: ${TRUSTED_PACKAGE_SOURCE_POLICY}
  --artifact-dir <dir>        Directory containing exactly one .tgz for source=artifact.
  --output-name <name>        Output tarball filename. Default: ${DEFAULT_OUTPUT_NAME}
  --metadata <file>           Write package metadata JSON.
  --github-output <file>      Append tarball, sha256, package name/version outputs.`;
}

export function parseArgs(argv) {
  const options = {
    artifactDir: "",
    githubOutput: "",
    metadata: "",
    outputDir: "",
    outputName: DEFAULT_OUTPUT_NAME,
    packageRef: "",
    packageSha256: "",
    packageSpec: "",
    packageUrl: "",
    source: "",
    trustedSourceId: "",
    trustedSourcePolicy: TRUSTED_PACKAGE_SOURCE_POLICY,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const readValue = (name) => {
      const value = argv[(index += 1)];
      if (value === undefined) {
        throw new Error(`${name} requires a value`);
      }
      return value;
    };
    if (arg === "--artifact-dir") {
      options.artifactDir = readValue(arg);
    } else if (arg === "--github-output") {
      options.githubOutput = readValue(arg);
    } else if (arg === "--metadata") {
      options.metadata = readValue(arg);
    } else if (arg === "--output-dir") {
      options.outputDir = readValue(arg);
    } else if (arg === "--output-name") {
      options.outputName = readValue(arg);
    } else if (arg === "--package-sha256") {
      options.packageSha256 = readValue(arg).toLowerCase();
    } else if (arg === "--package-ref") {
      options.packageRef = readValue(arg);
    } else if (arg === "--package-spec") {
      options.packageSpec = readValue(arg);
    } else if (arg === "--package-url") {
      options.packageUrl = readValue(arg);
    } else if (arg === "--source") {
      options.source = readValue(arg);
    } else if (arg === "--trusted-source-id") {
      options.trustedSourceId = readValue(arg);
    } else if (arg === "--trusted-source-policy") {
      options.trustedSourcePolicy = readValue(arg);
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

export function validateOpenClawPackageSpec(spec) {
  if (!OPENCLAW_PACKAGE_SPEC_RE.test(spec)) {
    throw new Error(
      `package_spec must be openclaw@alpha, openclaw@beta, openclaw@latest, or an exact OpenClaw release version; got: ${spec}`,
    );
  }
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? ROOT_DIR,
      stdio: options.capture ? ["ignore", "pipe", "pipe"] : ["ignore", "inherit", "inherit"],
    });
    let timedOut = false;
    const timeout =
      options.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            child.kill("SIGTERM");
            setTimeout(() => child.kill("SIGKILL"), 5_000).unref?.();
          }, options.timeoutMs);
    timeout?.unref?.();
    let stdout = "";
    let stderr = "";
    if (options.capture) {
      child.stdout.on("data", (chunk) => {
        stdout += String(chunk);
      });
      child.stderr.on("data", (chunk) => {
        stderr += String(chunk);
      });
    }
    child.on("error", reject);
    child.on("close", (status, signal) => {
      if (timeout) {
        clearTimeout(timeout);
      }
      if (timedOut) {
        reject(new Error(`${command} ${args.join(" ")} timed out after ${options.timeoutMs}ms`));
        return;
      }
      if (status === 0) {
        resolve(stdout);
        return;
      }
      const detail = stderr.trim() ? `\n${stderr.trim()}` : "";
      reject(new Error(`${command} ${args.join(" ")} failed with ${status ?? signal}${detail}`));
    });
  });
}

async function walkFiles(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkFiles(absolute)));
    } else if (entry.isFile()) {
      files.push(absolute);
    }
  }
  return files;
}

async function sha256(file) {
  const hash = createHash("sha256");
  const handle = await fs.open(file, "r");
  try {
    for await (const chunk of handle.createReadStream()) {
      hash.update(chunk);
    }
  } finally {
    await handle.close();
  }
  return hash.digest("hex");
}

function assertSha256(value) {
  if (!/^[a-f0-9]{64}$/u.test(value)) {
    throw new Error(`package_sha256 must be a lowercase or uppercase 64-character SHA-256 digest`);
  }
}

async function assertExpectedSha256(file, expected) {
  if (!expected) {
    return await sha256(file);
  }
  assertSha256(expected);
  const actual = await sha256(file);
  if (actual !== expected.toLowerCase()) {
    throw new Error(`package SHA-256 mismatch: expected ${expected}, got ${actual}`);
  }
  return actual;
}

async function findSingleTarball(dir) {
  const files = (await walkFiles(path.resolve(ROOT_DIR, dir)))
    .filter((file) => /\.t(?:ar\.)?gz$/u.test(path.basename(file)))
    .toSorted((a, b) => a.localeCompare(b));
  if (files.length !== 1) {
    throw new Error(
      `source=artifact requires exactly one .tgz under ${dir}; found ${files.length}: ${files.join(", ")}`,
    );
  }
  return files[0];
}

export async function readArtifactPackageCandidateMetadata(dir) {
  const metadataPath = path.join(path.resolve(ROOT_DIR, dir), "package-candidate.json");
  let raw = "";
  try {
    raw = await fs.readFile(metadataPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return {};
    }
    throw error;
  }
  const parsed = JSON.parse(raw);
  if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`artifact package-candidate.json must contain a JSON object`);
  }
  return parsed;
}

async function revParseTrustedInputRef(ref) {
  const candidates = [ref, `refs/remotes/origin/${ref}`, `refs/tags/${ref}`];
  for (const candidate of candidates) {
    const resolved = await run("git", ["rev-parse", "--verify", `${candidate}^{commit}`], {
      capture: true,
    }).then(
      (value) => value.trim(),
      () => "",
    );
    if (resolved) {
      return resolved;
    }
  }
  throw new Error(`package_ref does not resolve to a commit: ${ref}`);
}

async function resolveTrustedRepoRef(ref) {
  if (!ref || ref.trim() === "" || ref.startsWith("-")) {
    throw new Error(
      `package_ref must be a branch, tag, or full commit SHA; got: ${ref || "<empty>"}`,
    );
  }

  await run("git", ["fetch", "--no-tags", "origin", "+refs/heads/*:refs/remotes/origin/*"]);
  await run("git", ["fetch", "--tags", "origin", "+refs/tags/*:refs/tags/*"]);

  const selectedSha = await revParseTrustedInputRef(ref);
  const isMainAncestor = await run("git", [
    "merge-base",
    "--is-ancestor",
    selectedSha,
    "refs/remotes/origin/main",
  ]).then(
    () => true,
    () => false,
  );
  if (isMainAncestor) {
    return { selectedSha, trustedReason: "main-ancestor" };
  }

  const releaseTags = (await run("git", ["tag", "--points-at", selectedSha], { capture: true }))
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  if (releaseTags.some((tag) => tag.startsWith("v"))) {
    return { selectedSha, trustedReason: "release-tag" };
  }

  const containingBranches = (
    await run(
      "git",
      [
        "for-each-ref",
        "--format=%(refname:short)",
        "--contains",
        selectedSha,
        "refs/remotes/origin",
      ],
      { capture: true },
    )
  )
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  if (containingBranches.some((branch) => branch.startsWith("origin/"))) {
    return { selectedSha, trustedReason: "repository-branch-history" };
  }

  throw new Error(
    `package_ref ${ref} resolved to ${selectedSha}, which is not reachable from an OpenClaw branch or release tag`,
  );
}

async function preparePackageSourceWorktree(ref) {
  const { selectedSha, trustedReason } = await resolveTrustedRepoRef(ref);
  const sourceDir = path.join(
    process.env.RUNNER_TEMP || os.tmpdir(),
    `openclaw-package-source-${process.pid}`,
  );
  await fs.rm(sourceDir, { recursive: true, force: true });
  await run("git", ["worktree", "add", "--detach", sourceDir, selectedSha]);
  return { selectedSha, sourceDir, trustedReason };
}

async function installPackageSourceDeps(sourceDir) {
  await run(
    "pnpm",
    [
      "install",
      "--frozen-lockfile",
      "--ignore-scripts=false",
      "--config.engine-strict=false",
      "--config.enable-pre-post-scripts=true",
    ],
    { cwd: sourceDir },
  );
}

async function moveNewestPackedTarball(outputDir, packOutput, outputName) {
  let filename = "";
  try {
    const parsed = JSON.parse(packOutput);
    if (Array.isArray(parsed)) {
      filename = parsed.find((entry) => typeof entry?.filename === "string")?.filename ?? "";
    }
  } catch {}
  if (!filename) {
    for (const line of packOutput.split(/\r?\n/u)) {
      const trimmed = line.trim();
      if (/^openclaw-.*\.tgz$/u.test(trimmed)) {
        filename = trimmed;
      }
    }
  }
  if (!filename) {
    const entries = await fs.readdir(outputDir);
    filename = entries
      .filter((entry) => /^openclaw-.*\.tgz$/u.test(entry))
      .toSorted((a, b) => a.localeCompare(b))
      .at(-1);
  }
  if (!filename) {
    throw new Error(`npm pack produced no OpenClaw tarball in ${outputDir}`);
  }
  const packed = path.join(outputDir, filename);
  const target = path.join(outputDir, outputName);
  if (packed !== target) {
    await fs.rm(target, { force: true });
    await fs.rename(packed, target);
  }
  return target;
}

function normalizeUrlHostname(hostname) {
  return hostname.replace(/^\[/u, "").replace(/\]$/u, "").replace(/\.+$/u, "").toLowerCase();
}

function parseIpv4(address) {
  const parts = address.split(".");
  if (parts.length !== 4) {
    return null;
  }
  const octets = parts.map((part) => Number(part));
  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return null;
  }
  return octets;
}

function ipv4ToInt(octets) {
  return ((octets[0] << 24) >>> 0) + (octets[1] << 16) + (octets[2] << 8) + octets[3];
}

function ipv4InCidr(octets, base, bits) {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ipv4ToInt(octets) & mask) === (ipv4ToInt(base) & mask);
}

function isUnsafeIpv4(address) {
  const octets = parseIpv4(address);
  if (!octets) {
    return true;
  }
  return [
    [[0, 0, 0, 0], 8],
    [[10, 0, 0, 0], 8],
    [[100, 64, 0, 0], 10],
    [[127, 0, 0, 0], 8],
    [[169, 254, 0, 0], 16],
    [[172, 16, 0, 0], 12],
    [[192, 0, 0, 0], 24],
    [[192, 0, 2, 0], 24],
    [[192, 168, 0, 0], 16],
    [[198, 18, 0, 0], 15],
    [[198, 51, 100, 0], 24],
    [[203, 0, 113, 0], 24],
    [[224, 0, 0, 0], 4],
    [[240, 0, 0, 0], 4],
  ].some(([base, bits]) => ipv4InCidr(octets, base, bits));
}

function isUnsafeIpv6(address) {
  const normalized = address.toLowerCase();
  const embeddedIpv4 = normalized.match(/(?:::ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/u)?.[1];
  if (embeddedIpv4 && isUnsafeIpv4(embeddedIpv4)) {
    return true;
  }
  return (
    normalized === "::" ||
    normalized === "::1" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    /^fe[89ab]/u.test(normalized) ||
    normalized.startsWith("ff") ||
    normalized.startsWith("64:ff9b:") ||
    normalized.startsWith("100:") ||
    normalized.startsWith("2001:2:") ||
    normalized.startsWith("2001:db8:")
  );
}

function isUnsafeIpAddress(address) {
  const normalized = normalizeUrlHostname(address);
  const family = isIP(normalized);
  if (family === 4) {
    return isUnsafeIpv4(normalized);
  }
  if (family === 6) {
    return isUnsafeIpv6(normalized);
  }
  return true;
}

function isBlockedPackageHostname(hostname) {
  const normalized = normalizeUrlHostname(hostname);
  return (
    BLOCKED_PACKAGE_HOSTNAMES.has(normalized) ||
    normalized.endsWith(".localhost") ||
    normalized.endsWith(".local") ||
    normalized.endsWith(".internal") ||
    (isIP(normalized) !== 0 && isUnsafeIpAddress(normalized))
  );
}

function packageUrlPort(parsed) {
  return parsed.port ? Number(parsed.port) : 443;
}

function toUniqueNormalizedHostList(value, field, sourceId) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`trusted package source ${sourceId} must define non-empty ${field}`);
  }
  return [...new Set(value.map((entry) => normalizeUrlHostname(String(entry))).filter(Boolean))];
}

function toTrustedPorts(value, sourceId) {
  const ports = value === undefined ? [443] : value;
  if (!Array.isArray(ports) || ports.length === 0) {
    throw new Error(`trusted package source ${sourceId} must define non-empty ports`);
  }
  const normalized = ports.map((port) => Number(port));
  if (normalized.some((port) => !Number.isInteger(port) || port < 1 || port > 65535)) {
    throw new Error(`trusted package source ${sourceId} has invalid ports`);
  }
  return [...new Set(normalized)].toSorted((a, b) => a - b);
}

function toPathPrefixes(value, sourceId) {
  const prefixes = value === undefined ? ["/"] : value;
  if (!Array.isArray(prefixes) || prefixes.length === 0) {
    throw new Error(`trusted package source ${sourceId} must define non-empty pathPrefixes`);
  }
  return prefixes.map((prefix) => {
    const text = String(prefix);
    if (!text.startsWith("/")) {
      throw new Error(`trusted package source ${sourceId} pathPrefixes must start with /`);
    }
    return text;
  });
}

function normalizeTrustedPackageSource(id, raw) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(id)) {
    throw new Error(`Invalid trusted package source id: ${id}`);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`trusted package source ${id} must be an object`);
  }
  const hosts = toUniqueNormalizedHostList(raw.hosts, "hosts", id);
  const redirectHosts = raw.redirectHosts
    ? toUniqueNormalizedHostList(raw.redirectHosts, "redirectHosts", id)
    : hosts;
  const auth = raw.auth === undefined ? undefined : raw.auth;
  if (auth !== undefined) {
    if (!auth || typeof auth !== "object" || Array.isArray(auth) || auth.type !== "bearer") {
      throw new Error(`trusted package source ${id} auth must be {"type":"bearer"}`);
    }
    const authKeys = Object.keys(auth);
    if (authKeys.some((key) => key !== "type")) {
      throw new Error(`trusted package source ${id} auth only supports type`);
    }
  }
  return {
    allowPrivateNetwork: raw.allowPrivateNetwork === true,
    auth,
    hosts,
    id,
    pathPrefixes: toPathPrefixes(raw.pathPrefixes, id),
    ports: toTrustedPorts(raw.ports, id),
    redirectHosts,
  };
}

export async function loadTrustedPackageSource(id, policyPath = TRUSTED_PACKAGE_SOURCE_POLICY) {
  if (!id) {
    throw new Error("source=trusted-url requires --trusted-source-id");
  }
  const absolutePolicyPath = path.resolve(ROOT_DIR, policyPath);
  let policy;
  try {
    policy = JSON.parse(await fs.readFile(absolutePolicyPath, "utf8"));
  } catch (error) {
    throw new Error(`Unable to read trusted package source policy: ${policyPath}`, {
      cause: error,
    });
  }
  if (!policy || typeof policy !== "object" || policy.schemaVersion !== 1) {
    throw new Error(`Trusted package source policy must use schemaVersion 1: ${policyPath}`);
  }
  const sources = policy.sources;
  if (!sources || typeof sources !== "object" || Array.isArray(sources)) {
    throw new Error(`Trusted package source policy must define sources: ${policyPath}`);
  }
  if (!Object.hasOwn(sources, id)) {
    throw new Error(`Unknown trusted package source: ${id}`);
  }
  return normalizeTrustedPackageSource(id, sources[id]);
}

function validateTrustedPackageDownloadUrl(parsed, trustedSource, options = {}) {
  if (parsed.protocol !== "https:") {
    throw new Error(`package_url must use https: ${parsed.toString()}`);
  }
  if (parsed.username || parsed.password) {
    throw new Error(`package_url must not include credentials: ${parsed.origin}`);
  }
  const hostname = normalizeUrlHostname(parsed.hostname);
  const allowedHosts = options.isRedirect ? trustedSource.redirectHosts : trustedSource.hosts;
  if (!allowedHosts.includes(hostname)) {
    throw new Error(
      `package_url host ${parsed.hostname} is not allowed by trusted package source ${trustedSource.id}`,
    );
  }
  if (!trustedSource.ports.includes(packageUrlPort(parsed))) {
    throw new Error(
      `package_url port ${packageUrlPort(parsed)} is not allowed by trusted package source ${trustedSource.id}`,
    );
  }
  if (!trustedSource.pathPrefixes.some((prefix) => parsed.pathname.startsWith(prefix))) {
    throw new Error(
      `package_url path is not allowed by trusted package source ${trustedSource.id}`,
    );
  }
  if (!trustedSource.allowPrivateNetwork && isBlockedPackageHostname(parsed.hostname)) {
    throw new Error(
      `Blocked hostname or private/internal/special-use IP address: ${parsed.hostname}`,
    );
  }
}

function createTrustedPackageAuthHeaders(trustedSource) {
  if (!trustedSource?.auth) {
    return undefined;
  }
  const token = process.env[TRUSTED_PACKAGE_SOURCE_TOKEN_ENV];
  if (!token) {
    throw new Error(
      `trusted package source ${trustedSource.id} requires ${TRUSTED_PACKAGE_SOURCE_TOKEN_ENV}`,
    );
  }
  return { authorization: `Bearer ${token}` };
}

function validatePackageDownloadUrl(parsed) {
  if (parsed.protocol !== "https:") {
    throw new Error(`package_url must use https: ${parsed.toString()}`);
  }
  if (parsed.username || parsed.password) {
    throw new Error(`package_url must not include credentials: ${parsed.origin}`);
  }
  if (parsed.port && parsed.port !== "443") {
    throw new Error(`package_url must use the default HTTPS port: ${parsed.origin}`);
  }
  if (isBlockedPackageHostname(parsed.hostname)) {
    throw new Error(
      `Blocked hostname or private/internal/special-use IP address: ${parsed.hostname}`,
    );
  }
}

async function defaultLookupHost(hostname) {
  return await dnsLookup(hostname, { all: true, verbatim: true });
}

function normalizeLookupResults(results) {
  const entries = Array.isArray(results) ? results : [results];
  return entries
    .map((entry) => ({ address: String(entry.address ?? ""), family: Number(entry.family ?? 0) }))
    .filter((entry) => entry.address && (entry.family === 4 || entry.family === 6));
}

function createPinnedLookup(hostname, addresses) {
  const normalizedHost = normalizeUrlHostname(hostname);
  const records = addresses.map((address) => ({
    address,
    family: isIP(normalizeUrlHostname(address)),
  }));
  return (host, options, callback) => {
    const cb = typeof options === "function" ? options : callback;
    if (!cb) {
      return;
    }
    if (normalizeUrlHostname(host) !== normalizedHost) {
      if (typeof options === "function") {
        dnsLookupCb(host, cb);
        return;
      }
      dnsLookupCb(host, options, cb);
      return;
    }
    const opts = typeof options === "object" && options !== null ? options : {};
    const filtered = opts.family
      ? records.filter((record) => record.family === opts.family)
      : records;
    const usable = filtered.length > 0 ? filtered : records;
    if (opts.all) {
      cb(null, usable);
      return;
    }
    const chosen = usable[0];
    cb(null, chosen.address, chosen.family);
  };
}

async function resolvePackageDownloadAddresses(parsed, lookupHost, trustedSource) {
  const hostname = normalizeUrlHostname(parsed.hostname);
  if (isIP(hostname)) {
    if (!trustedSource?.allowPrivateNetwork && isUnsafeIpAddress(hostname)) {
      throw new Error(
        `Blocked: package_url resolves to private/internal/special-use IP address: ${hostname}`,
      );
    }
    return [hostname];
  }
  const results = normalizeLookupResults(await lookupHost(hostname));
  if (results.length === 0) {
    throw new Error(`Unable to resolve package_url hostname: ${parsed.hostname}`);
  }
  if (!trustedSource?.allowPrivateNetwork) {
    const blocked = results.find((entry) => isUnsafeIpAddress(entry.address));
    if (blocked) {
      throw new Error(
        `Blocked: package_url resolves to private/internal/special-use IP address: ${blocked.address}`,
      );
    }
  }
  return [...new Set(results.map((entry) => entry.address))];
}

async function openPackageDownloadResponse(url, options) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const lookupHost = options.lookupHost ?? defaultLookupHost;
  const timeoutMs = options.timeoutMs ?? PACKAGE_URL_DOWNLOAD_TIMEOUT_MS;
  const maxRedirects = options.maxRedirects ?? PACKAGE_URL_MAX_REDIRECTS;
  const trustedSource = options.trustedSource;
  const headers = createTrustedPackageAuthHeaders(trustedSource);
  let parsed = new URL(url);
  for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
    if (trustedSource) {
      validateTrustedPackageDownloadUrl(parsed, trustedSource, { isRedirect: redirectCount > 0 });
    } else {
      validatePackageDownloadUrl(parsed);
    }
    const addresses = await resolvePackageDownloadAddresses(parsed, lookupHost, trustedSource);
    const dispatcher = new Agent({
      connect: { lookup: createPinnedLookup(parsed.hostname, addresses) },
    });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    timeout.unref?.();
    const response = await fetchImpl(parsed, {
      dispatcher,
      headers,
      redirect: "manual",
      signal: controller.signal,
    }).catch(async (error) => {
      clearTimeout(timeout);
      await dispatcher.close();
      if (error?.name === "AbortError") {
        throw new Error(
          `package_url download timed out after ${timeoutMs}ms: ${parsed.toString()}`,
          {
            cause: error,
          },
        );
      }
      throw error;
    });

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      clearTimeout(timeout);
      response.body?.cancel();
      await dispatcher.close();
      const location = response.headers.get("location");
      if (!location) {
        throw new Error(`package_url redirect missing Location header: HTTP ${response.status}`);
      }
      parsed = new URL(location, parsed);
      continue;
    }
    return { dispatcher, response, timeout, timeoutMs };
  }
  throw new Error(`package_url exceeded ${maxRedirects} redirects: ${url}`);
}

async function* limitResponseBody(body, maxBytes) {
  let downloaded = 0;
  for await (const chunk of body) {
    const size = typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.byteLength;
    downloaded += size;
    if (downloaded > maxBytes) {
      throw new Error(`package_url exceeds maximum download size of ${maxBytes} bytes`);
    }
    yield chunk;
  }
}

export async function downloadUrl(url, target, options = {}) {
  const maxBytes = options.maxBytes ?? PACKAGE_URL_MAX_BYTES;
  const { dispatcher, response, timeout, timeoutMs } = await openPackageDownloadResponse(
    url,
    options,
  );
  const tempTarget = `${target}.tmp`;
  try {
    if (!response.ok || !response.body) {
      throw new Error(`failed to download package_url: HTTP ${response.status}`);
    }
    const contentLength = Number(response.headers.get("content-length") ?? "");
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      throw new Error(`package_url exceeds maximum download size of ${maxBytes} bytes`);
    }
    await fs.rm(tempTarget, { force: true });
    await pipeline(limitResponseBody(response.body, maxBytes), createWriteStream(tempTarget));
    await fs.rename(tempTarget, target);
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(`package_url download timed out after ${timeoutMs}ms: ${url}`, {
        cause: error,
      });
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    response.body?.cancel();
    await dispatcher.close();
    await fs.rm(tempTarget, { force: true });
  }
}

async function readPackageJson(tarball) {
  const raw = await run("tar", ["-xOf", tarball, "package/package.json"], { capture: true });
  const pkg = JSON.parse(raw);
  return {
    name: typeof pkg.name === "string" ? pkg.name : "",
    version: typeof pkg.version === "string" ? pkg.version : "",
  };
}

export async function readPackageBuildSourceSha(tarball) {
  const raw = await run("tar", ["-xOf", tarball, "package/dist/build-info.json"], {
    capture: true,
  }).then(
    (value) => value,
    () => "",
  );
  if (!raw.trim()) {
    return "";
  }
  const buildInfo = JSON.parse(raw);
  const commit = typeof buildInfo.commit === "string" ? buildInfo.commit.trim() : "";
  return /^[0-9a-f]{40}$/iu.test(commit) ? commit.toLowerCase() : "";
}

async function appendGithubOutputs(file, outputs) {
  if (!file) {
    return;
  }
  const body = Object.entries(outputs)
    .map(([key, value]) => `${key}=${String(value).replace(/\n/gu, " ")}`)
    .join("\n");
  await fs.appendFile(file, `${body}\n`);
}

async function resolveCandidate(options) {
  const outputDir = path.resolve(ROOT_DIR, options.outputDir);
  const target = path.join(outputDir, options.outputName || DEFAULT_OUTPUT_NAME);
  await fs.mkdir(outputDir, { recursive: true });
  await fs.rm(target, { force: true });
  let packageRef = "";
  let packageSourceSha = "";
  let packageTrustedReason = "";
  let packageTrustedSourceId = "";
  let packageWorktreeDir = "";
  let artifactMetadata = {};

  try {
    if (options.source === "ref") {
      packageRef = options.packageRef || "main";
      const packageSource = await preparePackageSourceWorktree(packageRef);
      packageWorktreeDir = packageSource.sourceDir;
      packageSourceSha = packageSource.selectedSha;
      packageTrustedReason = packageSource.trustedReason;
      await installPackageSourceDeps(packageSource.sourceDir);
      await run("node", [
        "scripts/package-openclaw-for-docker.mjs",
        "--source-dir",
        packageSource.sourceDir,
        "--output-dir",
        outputDir,
        "--output-name",
        options.outputName || DEFAULT_OUTPUT_NAME,
      ]);
    } else if (options.source === "npm") {
      validateOpenClawPackageSpec(options.packageSpec);
      const packOutput = await run(
        "npm",
        [
          "pack",
          options.packageSpec,
          "--ignore-scripts",
          "--json",
          "--pack-destination",
          outputDir,
        ],
        { capture: true },
      );
      await moveNewestPackedTarball(
        outputDir,
        packOutput,
        options.outputName || DEFAULT_OUTPUT_NAME,
      );
    } else if (options.source === "url" || options.source === "trusted-url") {
      if (!options.packageUrl) {
        throw new Error(`${options.source} requires --package-url`);
      }
      if (!options.packageSha256) {
        throw new Error(`${options.source} requires --package-sha256`);
      }
      if (options.source === "trusted-url") {
        const trustedSource = await loadTrustedPackageSource(
          options.trustedSourceId,
          options.trustedSourcePolicy,
        );
        await downloadUrl(options.packageUrl, target, { trustedSource });
        packageTrustedReason = `trusted-url-policy:${trustedSource.id}`;
        packageTrustedSourceId = trustedSource.id;
      } else {
        if (options.trustedSourceId) {
          throw new Error("--trusted-source-id is only allowed with source=trusted-url");
        }
        await downloadUrl(options.packageUrl, target);
      }
    } else if (options.source === "artifact") {
      if (!options.artifactDir) {
        throw new Error("source=artifact requires --artifact-dir");
      }
      artifactMetadata = await readArtifactPackageCandidateMetadata(options.artifactDir);
      packageRef =
        typeof artifactMetadata.packageRef === "string" ? artifactMetadata.packageRef : "";
      packageSourceSha =
        typeof artifactMetadata.packageSourceSha === "string"
          ? artifactMetadata.packageSourceSha
          : "";
      packageTrustedReason =
        typeof artifactMetadata.packageTrustedReason === "string"
          ? artifactMetadata.packageTrustedReason
          : "";
      const input = await findSingleTarball(options.artifactDir);
      await fs.copyFile(input, target);
    } else {
      throw new Error(
        `source must be one of: ref, npm, url, trusted-url, artifact. Got: ${options.source}`,
      );
    }
  } finally {
    if (packageWorktreeDir) {
      await run("git", ["worktree", "remove", "--force", packageWorktreeDir]).catch(() => {});
    }
  }

  const artifactSha256 = typeof artifactMetadata.sha256 === "string" ? artifactMetadata.sha256 : "";
  const digest = await assertExpectedSha256(target, options.packageSha256 || artifactSha256);
  console.error(`Checking OpenClaw package tarball: ${target}`);
  const checkStartedAt = Date.now();
  await run("node", ["scripts/check-openclaw-package-tarball.mjs", target], {
    timeoutMs: 5 * 60 * 1000,
  });
  console.error(
    `OpenClaw package tarball check finished in ${Math.round((Date.now() - checkStartedAt) / 1000)}s`,
  );
  const pkg = await readPackageJson(target);
  if (!packageSourceSha) {
    packageSourceSha = await readPackageBuildSourceSha(target);
    if (packageSourceSha && !packageTrustedReason) {
      packageTrustedReason = "package-build-info";
    }
  }
  const metadata = {
    name: pkg.name,
    packageRef,
    packageSpec: options.packageSpec || "",
    packageSourceSha,
    packageTrustedReason,
    trustedSourceId: packageTrustedSourceId,
    sha256: digest,
    source: options.source,
    tarball: path.relative(ROOT_DIR, target),
    version: pkg.version,
  };

  if (pkg.name !== "openclaw") {
    throw new Error(`package candidate must be named "openclaw"; got: ${pkg.name || "<missing>"}`);
  }
  if (!pkg.version) {
    throw new Error("package candidate package.json has no version");
  }

  if (options.metadata) {
    await fs.mkdir(path.dirname(path.resolve(ROOT_DIR, options.metadata)), { recursive: true });
    await fs.writeFile(
      path.resolve(ROOT_DIR, options.metadata),
      `${JSON.stringify(metadata, null, 2)}\n`,
    );
  }
  await appendGithubOutputs(options.githubOutput, {
    package_name: pkg.name,
    package_source_sha: packageSourceSha,
    package_version: pkg.version,
    sha256: digest,
    tarball: metadata.tarball,
  });
  return metadata;
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(usage());
    return;
  }
  if (!options.outputDir) {
    throw new Error("--output-dir is required");
  }
  const metadata = await resolveCandidate(options);
  console.log(JSON.stringify(metadata, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(usage());
    process.exit(1);
  });
}
