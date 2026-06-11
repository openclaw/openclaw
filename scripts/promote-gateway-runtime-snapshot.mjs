#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const GATEWAY_RUNTIME_SNAPSHOT_RELATIVE_DIR = path.join(
  ".artifacts",
  "openclaw-gateway-runtime",
);
export const GATEWAY_RUNTIME_SNAPSHOT_RELEASES_DIR = "releases";
export const GATEWAY_RUNTIME_SNAPSHOT_LATEST_FILE = "latest.json";
export const DEFAULT_GATEWAY_RUNTIME_SNAPSHOT_KEEP = 8;
const CONTROL_UI_COMPATIBILITY_ASSET_RELEASES = DEFAULT_GATEWAY_RUNTIME_SNAPSHOT_KEEP;
const CONTROL_UI_COMPATIBILITY_ASSET_EXTENSIONS = new Set([".css", ".js"]);

function normalizeTruthy(value) {
  const normalized = value?.trim().toLowerCase();
  return (
    normalized === "1" ||
    normalized === "true" ||
    normalized === "yes" ||
    normalized === "on" ||
    normalized === "force"
  );
}

function normalizeFalsy(value) {
  const normalized = value?.trim().toLowerCase();
  return (
    normalized === "0" || normalized === "false" || normalized === "no" || normalized === "off"
  );
}

function isSourceCheckoutRoot(rootDir, fsImpl = fs) {
  return (
    fsImpl.existsSync(path.join(rootDir, ".git")) &&
    fsImpl.existsSync(path.join(rootDir, "pnpm-workspace.yaml")) &&
    fsImpl.existsSync(path.join(rootDir, "src")) &&
    fsImpl.existsSync(path.join(rootDir, "extensions"))
  );
}

export function resolveGatewayRuntimeSnapshotPaths(rootDir = process.cwd()) {
  const snapshotDir = path.join(rootDir, GATEWAY_RUNTIME_SNAPSHOT_RELATIVE_DIR);
  const releasesDir = path.join(snapshotDir, GATEWAY_RUNTIME_SNAPSHOT_RELEASES_DIR);
  return {
    snapshotDir,
    releasesDir,
    latestPath: path.join(snapshotDir, GATEWAY_RUNTIME_SNAPSHOT_LATEST_FILE),
  };
}

export function shouldPromoteGatewayRuntimeSnapshot(params = {}) {
  const env = params.env ?? process.env;
  const rootDir = params.rootDir ?? process.cwd();
  const fsImpl = params.fs ?? fs;
  const requested = env.OPENCLAW_GATEWAY_RUNTIME_SNAPSHOT;
  if (normalizeFalsy(requested)) {
    return { promote: false, reason: "disabled" };
  }
  if (!isSourceCheckoutRoot(rootDir, fsImpl)) {
    return { promote: false, reason: "not-source-checkout" };
  }
  if (env.CI && !normalizeTruthy(requested)) {
    return { promote: false, reason: "ci" };
  }
  return { promote: true };
}

function assertPathExists(filePath, label, fsImpl) {
  if (!fsImpl.existsSync(filePath)) {
    throw new Error(`Cannot promote Gateway runtime snapshot; missing ${label}: ${filePath}`);
  }
}

function readJsonFileIfPresent(filePath, fsImpl) {
  try {
    return JSON.parse(fsImpl.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function readRequiredJsonFile(filePath, label, fsImpl) {
  try {
    return JSON.parse(fsImpl.readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(
      `Cannot promote Gateway runtime snapshot; invalid ${label}: ${filePath}${
        error instanceof Error ? ` (${error.message})` : ""
      }`,
      { cause: error },
    );
  }
}

function assertPromotableBuildInfo(buildInfo, filePath) {
  const version = typeof buildInfo?.version === "string" ? buildInfo.version.trim() : "";
  if (!version || version === "0.0.0") {
    throw new Error(
      `Cannot promote Gateway runtime snapshot; dist/build-info.json has no usable OpenClaw version: ${filePath}. Run pnpm build before promoting a Gateway runtime snapshot.`,
    );
  }
}

function parseKeepCount(value) {
  if (value === undefined || value === null || value === "") {
    return DEFAULT_GATEWAY_RUNTIME_SNAPSHOT_KEEP;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    return DEFAULT_GATEWAY_RUNTIME_SNAPSHOT_KEEP;
  }
  return Math.max(2, parsed);
}

function normalizeReleaseId(releaseId) {
  const normalized = String(releaseId ?? "").trim();
  if (!/^[A-Za-z0-9._-]+$/u.test(normalized)) {
    throw new Error(`Invalid Gateway runtime snapshot release id: ${releaseId}`);
  }
  return normalized;
}

function safeStat(filePath, fsImpl) {
  try {
    return fsImpl.statSync(filePath);
  } catch {
    return null;
  }
}

function directorySizeBytes(dirPath, fsImpl) {
  const stat = safeStat(dirPath, fsImpl);
  if (!stat) {
    return 0;
  }
  if (!stat.isDirectory()) {
    return stat.size;
  }
  let total = 0;
  let entries = [];
  try {
    entries = fsImpl.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    total += directorySizeBytes(path.join(dirPath, entry.name), fsImpl);
  }
  return total;
}

function releaseRootFromPath(candidatePath, releasesDir) {
  const relativePath = path.relative(releasesDir, path.resolve(candidatePath));
  if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    return null;
  }
  const releaseId = relativePath.split(path.sep)[0];
  return releaseId ? path.join(releasesDir, releaseId) : null;
}

function collectReleaseRootsFromText(text, releasesDir) {
  const roots = new Set();
  let start = text.indexOf(releasesDir);
  while (start >= 0) {
    let end = start;
    while (end < text.length && !/[\s<>"']/u.test(text[end])) {
      end += 1;
    }
    const root = releaseRootFromPath(text.slice(start, end), releasesDir);
    if (root) {
      roots.add(path.resolve(root));
    }
    start = text.indexOf(releasesDir, end);
  }
  return roots;
}

function collectLaunchAgentProtectedRoots(rootDir, fsImpl, env) {
  const home = env.HOME;
  if (!home) {
    return new Set();
  }
  const launchAgentsDir = path.join(home, "Library", "LaunchAgents");
  const { releasesDir } = resolveGatewayRuntimeSnapshotPaths(rootDir);
  const protectedRoots = new Set();
  let entries = [];
  try {
    entries = fsImpl.readdirSync(launchAgentsDir, { withFileTypes: true });
  } catch {
    return protectedRoots;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !/^ai\.openclaw(?:\.|$)/u.test(entry.name)) {
      continue;
    }
    const plistPath = path.join(launchAgentsDir, entry.name);
    const text = normalizeOptionalText(readTextFileIfPresent(plistPath, fsImpl));
    if (!text) {
      continue;
    }
    for (const root of collectReleaseRootsFromText(text, releasesDir)) {
      protectedRoots.add(root);
    }
  }
  return protectedRoots;
}

function readTextFileIfPresent(filePath, fsImpl) {
  try {
    return fsImpl.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

function normalizeOptionalText(value) {
  return typeof value === "string" && value.trim() ? value : null;
}

function collectProtectedReleaseRoots(params) {
  const rootDir = path.resolve(params.rootDir ?? process.cwd());
  const fsImpl = params.fs ?? fs;
  const env = params.env ?? process.env;
  const protectedRoots = new Set();
  const explicit = params.protectedRoots ?? [];
  for (const root of explicit) {
    if (root) {
      protectedRoots.add(path.resolve(root));
    }
  }
  const latest = readJsonFileIfPresent(
    resolveGatewayRuntimeSnapshotPaths(rootDir).latestPath,
    fsImpl,
  );
  if (typeof latest?.root === "string" && latest.root.trim()) {
    protectedRoots.add(path.resolve(latest.root));
  }
  for (const root of collectLaunchAgentProtectedRoots(rootDir, fsImpl, env)) {
    protectedRoots.add(path.resolve(root));
  }
  return protectedRoots;
}

export function listGatewayRuntimeSnapshotReleases(params = {}) {
  const rootDir = path.resolve(params.rootDir ?? process.cwd());
  const fsImpl = params.fs ?? fs;
  const { releasesDir } = resolveGatewayRuntimeSnapshotPaths(rootDir);
  let entries = [];
  try {
    entries = fsImpl.readdirSync(releasesDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const releaseRoot = path.join(releasesDir, entry.name);
      const snapshot = readJsonFileIfPresent(path.join(releaseRoot, "snapshot.json"), fsImpl);
      const stat = safeStat(releaseRoot, fsImpl);
      const createdAtMs =
        typeof snapshot?.createdAt === "string" ? Date.parse(snapshot.createdAt) : Number.NaN;
      return {
        releaseId: entry.name,
        root: releaseRoot,
        createdAt: typeof snapshot?.createdAt === "string" ? snapshot.createdAt : undefined,
        createdAtMs: Number.isFinite(createdAtMs) ? createdAtMs : (stat?.mtimeMs ?? 0),
        snapshot,
        sizeBytes: params.includeSize === true ? directorySizeBytes(releaseRoot, fsImpl) : 0,
      };
    })
    .toSorted((left, right) => {
      const byCreatedAt = right.createdAtMs - left.createdAtMs;
      return byCreatedAt !== 0 ? byCreatedAt : right.releaseId.localeCompare(left.releaseId);
    });
}

function isUsableRelease(releaseRoot, fsImpl) {
  return (
    fsImpl.existsSync(path.join(releaseRoot, "dist", "index.js")) &&
    fsImpl.existsSync(path.join(releaseRoot, "dist", "entry.js")) &&
    fsImpl.existsSync(path.join(releaseRoot, "dist", "control-ui", "index.html")) &&
    fsImpl.existsSync(path.join(releaseRoot, "dist-runtime", "extensions"))
  );
}

export function getGatewayRuntimeSnapshotStatus(params = {}) {
  const rootDir = path.resolve(params.rootDir ?? process.cwd());
  const fsImpl = params.fs ?? fs;
  const { snapshotDir, latestPath } = resolveGatewayRuntimeSnapshotPaths(rootDir);
  const latest = readJsonFileIfPresent(latestPath, fsImpl);
  const latestRoot =
    typeof latest?.root === "string" && latest.root.trim() ? path.resolve(latest.root) : null;
  const protectedRoots = collectProtectedReleaseRoots(params);
  const releases = listGatewayRuntimeSnapshotReleases({
    ...params,
    rootDir,
    includeSize: params.includeSize === true,
  }).map((release) => {
    const resolvedRoot = path.resolve(release.root);
    return Object.assign({}, release, {
      latest: latestRoot === resolvedRoot,
      protected: protectedRoots.has(resolvedRoot),
      usable: isUsableRelease(release.root, fsImpl),
    });
  });
  return {
    snapshotDir,
    latestPath,
    latestReleaseId: releases.find((release) => release.latest)?.releaseId ?? null,
    latestRoot,
    protectedRoots: [...protectedRoots].toSorted((left, right) => left.localeCompare(right)),
    releaseCount: releases.length,
    totalBytes: releases.reduce((total, release) => total + (release.sizeBytes ?? 0), 0),
    releases,
  };
}

export function pruneGatewayRuntimeSnapshots(params = {}) {
  const rootDir = path.resolve(params.rootDir ?? process.cwd());
  const env = params.env ?? process.env;
  const fsImpl = params.fs ?? fs;
  if (normalizeFalsy(env.OPENCLAW_GATEWAY_RUNTIME_SNAPSHOT_PRUNE)) {
    return { pruned: [], retained: [], skipped: "disabled" };
  }
  const keepCount = parseKeepCount(params.keepCount ?? env.OPENCLAW_GATEWAY_RUNTIME_SNAPSHOT_KEEP);
  const protectedRoots = collectProtectedReleaseRoots({ ...params, rootDir, env, fs: fsImpl });
  const releases = listGatewayRuntimeSnapshotReleases({ rootDir, fs: fsImpl });
  const retained = [];
  const pruned = [];
  for (const release of releases) {
    const releaseRoot = path.resolve(release.root);
    const protectedRelease = protectedRoots.has(releaseRoot);
    if (protectedRelease || retained.length < keepCount) {
      retained.push({
        releaseId: release.releaseId,
        root: release.root,
        protected: protectedRelease,
      });
      continue;
    }
    fsImpl.rmSync(release.root, { recursive: true, force: true });
    pruned.push({ releaseId: release.releaseId, root: release.root });
  }
  return { keepCount, pruned, retained };
}

export function rollbackGatewayRuntimeSnapshot(params = {}) {
  const rootDir = path.resolve(params.rootDir ?? process.cwd());
  const fsImpl = params.fs ?? fs;
  const releaseId = normalizeReleaseId(params.releaseId);
  const { releasesDir, latestPath } = resolveGatewayRuntimeSnapshotPaths(rootDir);
  const releaseRoot = path.join(releasesDir, releaseId);
  if (!isUsableRelease(releaseRoot, fsImpl)) {
    throw new Error(
      `Cannot roll back Gateway runtime snapshot; release is incomplete: ${releaseId}`,
    );
  }
  const snapshot = readJsonFileIfPresent(path.join(releaseRoot, "snapshot.json"), fsImpl) ?? {
    version: 1,
    releaseId,
    root: releaseRoot,
    createdAt: new Date().toISOString(),
    source: { root: rootDir, buildStamp: null, runtimePostbuildStamp: null },
    paths: {
      entrypoint: path.join(releaseRoot, "dist", "index.js"),
      controlUi: path.join(releaseRoot, "dist", "control-ui"),
      bundledPlugins: path.join(releaseRoot, "dist-runtime", "extensions"),
    },
  };
  writeJsonAtomic(latestPath, { ...snapshot, releaseId, root: releaseRoot }, fsImpl);
  return { rolledBack: true, releaseId, releaseRoot, latestPath };
}

function createReleaseId(now = new Date(), pid = process.pid) {
  const timestamp = now
    .toISOString()
    .replaceAll(":", "")
    .replaceAll("-", "")
    .replace(/\.\d+Z$/u, "Z");
  return `${timestamp}-${pid}`;
}

function writeJsonAtomic(filePath, payload, fsImpl) {
  fsImpl.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fsImpl.writeFileSync(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  fsImpl.renameSync(tmpPath, filePath);
}

function copyRuntimeTree(sourceDir, targetDir, fsImpl) {
  fsImpl.rmSync(targetDir, { recursive: true, force: true });
  fsImpl.mkdirSync(path.dirname(targetDir), { recursive: true });
  fsImpl.cpSync(sourceDir, targetDir, {
    recursive: true,
    force: true,
    errorOnExist: false,
    verbatimSymlinks: true,
  });
}

function copyControlUiCompatibilityAssets(params) {
  const rootDir = path.resolve(params.rootDir ?? process.cwd());
  const fsImpl = params.fs ?? fs;
  const stagingRoot = params.stagingRoot;
  const targetAssetsDir = path.join(stagingRoot, "dist", "control-ui", "assets");
  if (!fsImpl.existsSync(targetAssetsDir)) {
    return { copied: 0, releases: [] };
  }

  const releases = listGatewayRuntimeSnapshotReleases({ rootDir, fs: fsImpl }).slice(
    0,
    params.maxReleases ?? CONTROL_UI_COMPATIBILITY_ASSET_RELEASES,
  );
  let copied = 0;
  const copiedFromReleases = [];
  for (const release of releases) {
    const sourceAssetsDir = path.join(release.root, "dist", "control-ui", "assets");
    let entries = [];
    try {
      entries = fsImpl.readdirSync(sourceAssetsDir, { withFileTypes: true });
    } catch {
      continue;
    }
    let copiedFromRelease = false;
    for (const entry of entries) {
      if (!entry.isFile()) {
        continue;
      }
      if (!CONTROL_UI_COMPATIBILITY_ASSET_EXTENSIONS.has(path.extname(entry.name))) {
        continue;
      }
      const sourcePath = path.join(sourceAssetsDir, entry.name);
      const targetPath = path.join(targetAssetsDir, entry.name);
      if (fsImpl.existsSync(targetPath)) {
        continue;
      }
      fsImpl.copyFileSync(sourcePath, targetPath);
      copied += 1;
      copiedFromRelease = true;
    }
    if (copiedFromRelease) {
      copiedFromReleases.push(release.releaseId);
    }
  }
  return { copied, releases: copiedFromReleases };
}

export function promoteGatewayRuntimeSnapshot(params = {}) {
  const rootDir = path.resolve(params.rootDir ?? process.cwd());
  const env = params.env ?? process.env;
  const fsImpl = params.fs ?? fs;
  const decision = shouldPromoteGatewayRuntimeSnapshot({ rootDir, env, fs: fsImpl });
  if (!decision.promote) {
    return { promoted: false, reason: decision.reason };
  }

  const distDir = path.join(rootDir, "dist");
  const distRuntimeDir = path.join(rootDir, "dist-runtime");
  assertPathExists(path.join(distDir, "index.js"), "dist/index.js", fsImpl);
  assertPathExists(path.join(distDir, "entry.js"), "dist/entry.js", fsImpl);
  const buildInfoPath = path.join(distDir, "build-info.json");
  assertPathExists(path.join(distDir, "build-info.json"), "dist/build-info.json", fsImpl);
  assertPathExists(path.join(distDir, "control-ui", "index.html"), "Control UI assets", fsImpl);
  assertPathExists(path.join(distRuntimeDir, "extensions"), "dist-runtime/extensions", fsImpl);
  const buildInfo = readRequiredJsonFile(buildInfoPath, "dist/build-info.json", fsImpl);
  assertPromotableBuildInfo(buildInfo, buildInfoPath);

  const { snapshotDir, releasesDir, latestPath } = resolveGatewayRuntimeSnapshotPaths(rootDir);
  const releaseId = params.releaseId ?? createReleaseId(params.now, params.pid ?? process.pid);
  const releaseRoot = path.join(releasesDir, releaseId);
  const stagingRoot = path.join(snapshotDir, `.staging-${releaseId}`);
  fsImpl.rmSync(stagingRoot, { recursive: true, force: true });
  fsImpl.mkdirSync(stagingRoot, { recursive: true });

  try {
    copyRuntimeTree(distDir, path.join(stagingRoot, "dist"), fsImpl);
    copyRuntimeTree(distRuntimeDir, path.join(stagingRoot, "dist-runtime"), fsImpl);
    const controlUiCompatibilityAssets = copyControlUiCompatibilityAssets({
      rootDir,
      fs: fsImpl,
      stagingRoot,
    });
    const buildStamp = readJsonFileIfPresent(path.join(distDir, ".buildstamp"), fsImpl);
    const runtimePostbuildStamp = readJsonFileIfPresent(
      path.join(distDir, ".runtime-postbuildstamp"),
      fsImpl,
    );
    const snapshot = {
      version: 1,
      releaseId,
      root: releaseRoot,
      createdAt: new Date().toISOString(),
      source: {
        root: rootDir,
        buildStamp,
        runtimePostbuildStamp,
        controlUiCompatibilityAssets,
      },
      paths: {
        entrypoint: path.join(releaseRoot, "dist", "index.js"),
        controlUi: path.join(releaseRoot, "dist", "control-ui"),
        bundledPlugins: path.join(releaseRoot, "dist-runtime", "extensions"),
      },
    };
    writeJsonAtomic(path.join(stagingRoot, "snapshot.json"), snapshot, fsImpl);
    fsImpl.mkdirSync(releasesDir, { recursive: true });
    fsImpl.renameSync(stagingRoot, releaseRoot);
    writeJsonAtomic(latestPath, snapshot, fsImpl);
    const pruning =
      params.prune === false
        ? { pruned: [], retained: [], skipped: "disabled" }
        : pruneGatewayRuntimeSnapshots({
            rootDir,
            env,
            fs: fsImpl,
            keepCount: params.keepCount,
            protectedRoots: [releaseRoot, ...(params.protectedRoots ?? [])],
          });
    return { promoted: true, releaseRoot, releaseId, latestPath, pruning };
  } catch (error) {
    fsImpl.rmSync(stagingRoot, { recursive: true, force: true });
    throw error;
  }
}

function hasArg(args, name) {
  return args.includes(name);
}

function valueAfterArg(args, name) {
  const index = args.indexOf(name);
  if (index < 0 || index + 1 >= args.length) {
    return null;
  }
  const value = args[index + 1];
  return value.startsWith("-") ? null : value;
}

function omitLargeSnapshotPayload(status) {
  return {
    ...status,
    releases: status.releases.map(({ snapshot, ...release }) => release),
  };
}

function printJson(payload) {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 B";
  }
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value >= 10 || unitIndex === 0 ? value.toFixed(0) : value.toFixed(1)} ${
    units[unitIndex]
  }`;
}

function printStatus(status) {
  console.error("[gateway-runtime-snapshot] status");
  console.error(`  latest: ${status.latestReleaseId ?? "none"}`);
  console.error(`  releases: ${status.releaseCount}`);
  console.error(`  total size: ${formatBytes(status.totalBytes)}`);
  for (const release of status.releases) {
    const markers = [
      release.latest ? "latest" : null,
      release.protected ? "protected" : null,
      release.usable ? null : "incomplete",
    ].filter(Boolean);
    console.error(`  - ${release.releaseId}${markers.length ? ` (${markers.join(", ")})` : ""}`);
  }
}

function printPruneResult(result) {
  if (result.skipped) {
    console.error(`[gateway-runtime-snapshot] prune skipped (${result.skipped})`);
    return;
  }
  console.error(
    `[gateway-runtime-snapshot] pruned ${result.pruned.length}; retained ${result.retained.length}`,
  );
  for (const release of result.pruned) {
    console.error(`  - ${release.releaseId}`);
  }
}

function printRollbackResult(result) {
  console.error(`[gateway-runtime-snapshot] rolled back latest snapshot to ${result.releaseId}`);
  console.error("[gateway-runtime-snapshot] restart the Gateway to activate this release");
}

function isMainModule() {
  const argv1 = process.argv[1];
  return Boolean(argv1 && import.meta.url === pathToFileURL(argv1).href);
}

if (isMainModule()) {
  try {
    const args = process.argv.slice(2);
    const json = hasArg(args, "--json");
    if (hasArg(args, "--status")) {
      const status = omitLargeSnapshotPayload(
        getGatewayRuntimeSnapshotStatus({ includeSize: true }),
      );
      if (json) {
        printJson(status);
      } else {
        printStatus(status);
      }
      process.exit(0);
    }
    if (hasArg(args, "--prune")) {
      const result = pruneGatewayRuntimeSnapshots();
      if (json) {
        printJson(result);
      } else {
        printPruneResult(result);
      }
      process.exit(0);
    }
    const rollbackReleaseId = valueAfterArg(args, "--rollback");
    if (rollbackReleaseId) {
      const result = rollbackGatewayRuntimeSnapshot({ releaseId: rollbackReleaseId });
      if (json) {
        printJson(result);
      } else {
        printRollbackResult(result);
      }
      process.exit(0);
    }
    const result = promoteGatewayRuntimeSnapshot();
    if (result.promoted) {
      const prunedCount = result.pruning?.pruned?.length ?? 0;
      console.error(
        `[gateway-runtime-snapshot] promoted ${result.releaseId}; pruned ${prunedCount}`,
      );
    } else {
      console.error(`[gateway-runtime-snapshot] skipped (${result.reason})`);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
