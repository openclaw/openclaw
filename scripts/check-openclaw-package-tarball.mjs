#!/usr/bin/env node
// Validates the npm tarball Docker E2E lanes install.
// This is intentionally tarball-only: the check proves Docker lanes consume the
// prebuilt package artifact with dist inventory, not a source checkout.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { isLegacyContentInventoryCompatVersion } from "./lib/content-inventory-compat.mjs";
import { LOCAL_BUILD_METADATA_DIST_PATHS } from "./lib/local-build-metadata-paths.mjs";
import {
  collectPackageDistImports,
  collectPackageDistImportErrors,
  expandPackageDistImportClosure,
} from "./lib/package-dist-imports.mjs";

function usage() {
  return "Usage: node scripts/check-openclaw-package-tarball.mjs <openclaw.tgz>";
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

function parseArgs(argv) {
  const args = argv[0] === "--" ? argv.slice(1) : argv;
  const tarball = args[0]?.trim() ?? "";
  if (tarball === "--help" || tarball === "-h") {
    return { help: true, tarball: "" };
  }
  if (!tarball) {
    throw new Error(usage());
  }
  if (tarball.startsWith("-")) {
    throw new Error(`Unknown OpenClaw package tarball check option: ${tarball}`);
  }
  const extraArg = args[1]?.trim();
  if (extraArg) {
    throw new Error(`Unexpected OpenClaw package tarball check argument: ${extraArg}`);
  }
  return { help: false, tarball };
}

let cliArgs;
try {
  cliArgs = parseArgs(process.argv.slice(2));
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
if (cliArgs.help) {
  console.log(usage());
  process.exit(0);
}

const { tarball } = cliArgs;
if (!fs.existsSync(tarball)) {
  fail(`OpenClaw package tarball does not exist: ${tarball}`);
}

const phaseTimingsEnabled = process.env.OPENCLAW_PACKAGE_TARBALL_CHECK_TIMINGS !== "0";
function runPhase(label, action) {
  const startedAt = performance.now();
  try {
    return action();
  } finally {
    if (phaseTimingsEnabled) {
      const durationMs = Math.round(performance.now() - startedAt);
      console.error(`check-openclaw-package-tarball: ${label} completed in ${durationMs}ms`);
    }
  }
}

const list = runPhase("tar list", () =>
  spawnSync("tar", ["-tf", tarball], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }),
);
if (list.status !== 0) {
  fail(`tar -tf failed for ${tarball}: ${list.stderr || list.status}`);
}

const extractDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-package-tarball-"));
try {
  const extract = runPhase("tar extract", () =>
    spawnSync("tar", ["-xf", tarball, "-C", extractDir], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }),
  );
  if (extract.status !== 0) {
    fs.rmSync(extractDir, { recursive: true, force: true });
    fail(`tar -xf failed for ${tarball}: ${extract.stderr || extract.status}`);
  }
} catch (error) {
  fs.rmSync(extractDir, { recursive: true, force: true });
  throw error;
}

const entries = list.stdout
  .split(/\r?\n/u)
  .map((entry) => entry.trim())
  .filter(Boolean);
const listedNormalized = entries.map((entry) => entry.replace(/^package\//u, ""));
const normalized = listedNormalized.map((entry) => (entry ? path.posix.normalize(entry) : entry));
const packageNormalized = entries
  .filter((entry) => entry.startsWith("package/"))
  .map((entry) => entry.slice("package/".length))
  .map((entry) => (entry ? path.posix.normalize(entry) : entry))
  .filter(Boolean);
const packageEntrySet = new Set(packageNormalized);
const normalizedEntryCounts = new Map();
const errors = [];
const warnings = [];
const REQUIRED_TARBALL_ENTRIES = ["dist/control-ui/index.html"];
const REQUIRED_TARBALL_ENTRY_PREFIXES = ["dist/control-ui/assets/"];
const LEGACY_PACKAGE_ACCEPTANCE_COMPAT_MAX = { year: 2026, month: 4, day: 25 };
const LEGACY_LOCAL_BUILD_METADATA_COMPAT_MAX = { year: 2026, month: 4, day: 26 };
const LEGACY_SHRINKWRAP_COMPAT_MAX = { year: 2026, month: 5, day: 20 };
const FORBIDDEN_LOCAL_BUILD_METADATA_FILES = new Set(LOCAL_BUILD_METADATA_DIST_PATHS);
const PACKAGE_DIST_INVENTORY_METADATA_FILES = new Set([
  "dist/postinstall-inventory.json",
  "dist/postinstall-content-inventory.json",
  "dist/plugin-sdk/.tsbuildinfo",
]);

const LEGACY_OMITTED_PRIVATE_QA_INVENTORY_PREFIXES = [
  "dist/extensions/qa-channel/",
  "dist/extensions/qa-lab/",
  "dist/extensions/qa-matrix/",
  "dist/plugin-sdk/extensions/qa-channel/",
  "dist/plugin-sdk/extensions/qa-lab/",
];
const LEGACY_OMITTED_PRIVATE_QA_INVENTORY_FILES = new Set([
  "dist/plugin-sdk/qa-channel.d.ts",
  "dist/plugin-sdk/qa-channel.js",
  "dist/plugin-sdk/qa-channel-protocol.d.ts",
  "dist/plugin-sdk/qa-channel-protocol.js",
  "dist/plugin-sdk/qa-lab.d.ts",
  "dist/plugin-sdk/qa-lab.js",
  "dist/plugin-sdk/qa-runtime.d.ts",
  "dist/plugin-sdk/qa-runtime.js",
  "dist/plugin-sdk/src/plugin-sdk/qa-channel.d.ts",
  "dist/plugin-sdk/src/plugin-sdk/qa-channel-protocol.d.ts",
  "dist/plugin-sdk/src/plugin-sdk/qa-lab.d.ts",
  "dist/plugin-sdk/src/plugin-sdk/qa-runtime.d.ts",
]);

function isLegacyOmittedPrivateQaInventoryEntry(relativePath) {
  return (
    LEGACY_OMITTED_PRIVATE_QA_INVENTORY_FILES.has(relativePath) ||
    LEGACY_OMITTED_PRIVATE_QA_INVENTORY_PREFIXES.some((prefix) => relativePath.startsWith(prefix))
  );
}

function isAllowedMissingContentInventoryEntry(relativePath) {
  return (
    isLegacyPackageAcceptanceCompatVersion(packageVersion) &&
    isLegacyOmittedPrivateQaInventoryEntry(relativePath)
  );
}

function isExpectedPackageDistInventoryEntry(relativePath) {
  return (
    relativePath.startsWith("dist/") &&
    !relativePath.endsWith("/") &&
    !PACKAGE_DIST_INVENTORY_METADATA_FILES.has(relativePath) &&
    !FORBIDDEN_LOCAL_BUILD_METADATA_FILES.has(relativePath) &&
    !isAllowedMissingContentInventoryEntry(relativePath)
  );
}

function parseCalver(version) {
  const match = /^(\d{4})\.(\d{1,2})\.(\d{1,2})(?:[-+].*)?$/u.exec(version);
  if (!match) {
    return null;
  }
  return {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
  };
}

function compareCalver(left, right) {
  for (const key of ["year", "month", "day"]) {
    if (left[key] !== right[key]) {
      return left[key] - right[key];
    }
  }
  return 0;
}

function isLegacyPackageAcceptanceCompatVersion(version) {
  const parsed = parseCalver(version);
  return parsed ? compareCalver(parsed, LEGACY_PACKAGE_ACCEPTANCE_COMPAT_MAX) <= 0 : false;
}

function isLegacyLocalBuildMetadataCompatVersion(version) {
  const parsed = parseCalver(version);
  return parsed ? compareCalver(parsed, LEGACY_LOCAL_BUILD_METADATA_COMPAT_MAX) <= 0 : false;
}

function isLegacyShrinkwrapCompatVersion(version) {
  const parsed = parseCalver(version);
  return parsed ? compareCalver(parsed, LEGACY_SHRINKWRAP_COMPAT_MAX) <= 0 : false;
}

function isSafeTarEntryPath(entryPath) {
  return (
    entryPath.startsWith("dist/") &&
    !entryPath.startsWith("/") &&
    !entryPath.includes("\0") &&
    !entryPath.split("/").includes("..")
  );
}

function resolveExtractedTarEntry(entryPath, packageScoped) {
  if (
    !isSafeTarEntryPath(entryPath) &&
    entryPath !== "package.json" &&
    entryPath !== "npm-shrinkwrap.json"
  ) {
    return null;
  }
  const root = packageScoped ? path.join(extractDir, "package") : extractDir;
  const candidate = path.resolve(root, entryPath);
  const rootPrefix = `${path.resolve(root)}${path.sep}`;
  return candidate.startsWith(rootPrefix) ? candidate : null;
}

function hasUnsafeExtractedAncestor(candidate, root) {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  const relativePath = path.relative(resolvedRoot, resolvedCandidate);
  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    return true;
  }
  const rootStats = fs.lstatSync(resolvedRoot);
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
    return true;
  }
  let current = resolvedRoot;
  for (const part of relativePath.split(path.sep).slice(0, -1)) {
    current = path.join(current, part);
    let stats;
    try {
      stats = fs.lstatSync(current);
    } catch (error) {
      if (error && typeof error === "object" && error.code === "ENOENT") {
        return false;
      }
      throw error;
    }
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      return true;
    }
  }
  return false;
}

function collectUnsafeExtractedDistTreeErrors() {
  const roots = [
    { label: "dist", root: path.join(extractDir, "dist") },
    { label: "package/dist", root: path.join(extractDir, "package", "dist") },
  ];
  const treeErrors = [];
  const visit = (dir, label) => {
    const dirEntries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of dirEntries) {
      const entryPath = path.join(dir, entry.name);
      const entryLabel = `${label}/${entry.name}`;
      if (entry.isSymbolicLink()) {
        treeErrors.push(`unsafe extracted dist entry: ${entryLabel}`);
        continue;
      }
      if (entry.isDirectory()) {
        visit(entryPath, entryLabel);
      }
    }
  };
  for (const { label, root } of roots) {
    if (hasUnsafeExtractedAncestor(root, extractDir)) {
      treeErrors.push(`unsafe extracted dist root: ${label}`);
      continue;
    }
    let stats;
    try {
      stats = fs.lstatSync(root);
    } catch (error) {
      if (error && typeof error === "object" && error.code === "ENOENT") {
        continue;
      }
      throw error;
    }
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      treeErrors.push(`unsafe extracted dist root: ${label}`);
      continue;
    }
    visit(root, label);
  }
  return treeErrors;
}

function readPackageTarEntry(entryPath) {
  const candidate = resolveExtractedTarEntry(entryPath, true);
  if (candidate && fs.existsSync(candidate)) {
    return fs.readFileSync(candidate, "utf8");
  }
  return "";
}

function readPackageTarEntryBuffer(
  entryPath,
  unsafeEntryLabel = "unsafe content inventory tar entry",
) {
  const candidate = resolveExtractedTarEntry(entryPath, true);
  const root = path.join(extractDir, "package");
  if (candidate && fs.existsSync(candidate)) {
    if (hasUnsafeExtractedAncestor(candidate, root)) {
      return { error: `${unsafeEntryLabel} ${entryPath}` };
    }
    const stats = fs.lstatSync(candidate);
    if (!stats.isFile() || stats.isSymbolicLink()) {
      return { error: `${unsafeEntryLabel} ${entryPath}` };
    }
    return { content: fs.readFileSync(candidate), mode: stats.mode };
  }
  return { content: null };
}

function readPackageMetadataTarEntry(entryPath) {
  const { content, error } = readPackageTarEntryBuffer(
    entryPath,
    "unsafe package metadata tar entry",
  );
  if (error) {
    throw new Error(error);
  }
  return content?.toString("utf8") ?? "";
}

function sha256Hex(content) {
  return createHash("sha256").update(content).digest("hex");
}

function isContentInventoryEntry(entry) {
  return (
    entry &&
    typeof entry === "object" &&
    typeof entry.path === "string" &&
    typeof entry.sha256 === "string" &&
    /^[a-f0-9]{64}$/u.test(entry.sha256) &&
    Number.isInteger(entry.mode) &&
    entry.mode >= 0 &&
    Number.isInteger(entry.size) &&
    entry.size >= 0
  );
}

for (const [index, entry] of listedNormalized.entries()) {
  const canonicalEntry = normalized[index] ?? "";
  if (canonicalEntry) {
    normalizedEntryCounts.set(canonicalEntry, (normalizedEntryCounts.get(canonicalEntry) ?? 0) + 1);
  }
  if (
    entry.startsWith("/") ||
    entry.split("/").includes("..") ||
    entry.split("/").includes(".") ||
    canonicalEntry !== entry
  ) {
    errors.push(`unsafe tar entry: ${entry}`);
  }
}
for (const [entry, count] of normalizedEntryCounts) {
  if (count > 1) {
    errors.push(`duplicate normalized tar entry: ${entry}`);
  }
}
const unsafeExtractedDistTreeErrors = collectUnsafeExtractedDistTreeErrors();
if (unsafeExtractedDistTreeErrors.length > 0) {
  fs.rmSync(extractDir, { recursive: true, force: true });
  fail(
    `OpenClaw package tarball integrity failed:\n${[...errors, ...unsafeExtractedDistTreeErrors].join("\n")}`,
  );
}

if (!packageEntrySet.has("package.json")) {
  errors.push("missing package.json");
}
if (!packageNormalized.some((entry) => entry.startsWith("dist/"))) {
  errors.push("missing dist/ entries");
}
for (const requiredEntry of REQUIRED_TARBALL_ENTRIES) {
  if (!packageEntrySet.has(requiredEntry)) {
    errors.push(`missing required tar entry ${requiredEntry}`);
  }
}
for (const requiredPrefix of REQUIRED_TARBALL_ENTRY_PREFIXES) {
  if (!packageNormalized.some((entry) => entry.startsWith(requiredPrefix))) {
    errors.push(`missing required tar entries under ${requiredPrefix}`);
  }
}
let packageVersion = "";
if (packageEntrySet.has("package.json")) {
  try {
    const packageJson = JSON.parse(readPackageMetadataTarEntry("package.json"));
    packageVersion = typeof packageJson.version === "string" ? packageJson.version : "";
  } catch (error) {
    packageVersion = "";
    errors.push(
      `unreadable package.json: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
const expectedPackageDistInventoryEntries = [
  ...new Set(packageNormalized.filter(isExpectedPackageDistInventoryEntry)),
].toSorted((left, right) => left.localeCompare(right));
if (packageEntrySet.has("package-lock.json")) {
  errors.push("package tarball must ship npm-shrinkwrap.json, not package-lock.json");
}
if (!packageEntrySet.has("npm-shrinkwrap.json")) {
  if (isLegacyShrinkwrapCompatVersion(packageVersion)) {
    warnings.push("legacy package omits npm-shrinkwrap.json");
  } else {
    errors.push("missing required tar entry npm-shrinkwrap.json");
  }
} else {
  try {
    const shrinkwrap = JSON.parse(readPackageMetadataTarEntry("npm-shrinkwrap.json"));
    const rootPackage = shrinkwrap.packages?.[""];
    if (shrinkwrap.name !== "openclaw") {
      errors.push("npm-shrinkwrap.json root name must be openclaw");
    }
    if (shrinkwrap.version !== packageVersion) {
      errors.push(
        `npm-shrinkwrap.json version ${shrinkwrap.version ?? "<missing>"} does not match package.json version ${packageVersion || "<missing>"}`,
      );
    }
    if (!rootPackage || rootPackage.name !== "openclaw") {
      errors.push("npm-shrinkwrap.json packages root must name openclaw");
    }
    if (rootPackage?.version !== packageVersion) {
      errors.push(
        `npm-shrinkwrap.json packages root version ${rootPackage?.version ?? "<missing>"} does not match package.json version ${packageVersion || "<missing>"}`,
      );
    }
    if (rootPackage?.devDependencies) {
      errors.push("npm-shrinkwrap.json must not lock root devDependencies");
    }
    const devLockedPackages = Object.entries(shrinkwrap.packages ?? {})
      .filter(([, packageMetadata]) => packageMetadata?.dev === true)
      .map(([packagePath]) => packagePath);
    if (devLockedPackages.length > 0) {
      errors.push(
        `npm-shrinkwrap.json must not lock dev packages: ${devLockedPackages.slice(0, 5).join(", ")}`,
      );
    }
  } catch (error) {
    errors.push(
      `unreadable npm-shrinkwrap.json: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
for (const forbiddenEntry of FORBIDDEN_LOCAL_BUILD_METADATA_FILES) {
  if (packageEntrySet.has(forbiddenEntry)) {
    if (isLegacyLocalBuildMetadataCompatVersion(packageVersion)) {
      warnings.push(`legacy package includes local build metadata tar entry ${forbiddenEntry}`);
      continue;
    }
    errors.push(`forbidden local build metadata tar entry ${forbiddenEntry}`);
  }
}
if (!packageEntrySet.has("dist/postinstall-inventory.json")) {
  errors.push("missing dist/postinstall-inventory.json");
}
if (!packageEntrySet.has("dist/postinstall-content-inventory.json")) {
  if (isLegacyContentInventoryCompatVersion(packageVersion)) {
    warnings.push("legacy package omits dist/postinstall-content-inventory.json");
  } else {
    errors.push("missing dist/postinstall-content-inventory.json");
  }
}
let packageDistImports = null;
let normalizedInventory = null;
if (packageEntrySet.has("dist/postinstall-inventory.json")) {
  try {
    const allowLegacyPrivateQaInventoryOmissions =
      isLegacyPackageAcceptanceCompatVersion(packageVersion);
    const inventory = JSON.parse(readPackageMetadataTarEntry("dist/postinstall-inventory.json"));
    if (!Array.isArray(inventory) || inventory.some((entry) => typeof entry !== "string")) {
      errors.push("invalid dist/postinstall-inventory.json");
    } else {
      normalizedInventory = inventory.map((entry) => entry.replace(/\\/gu, "/"));
      const normalizedInventorySet = new Set(normalizedInventory);
      for (const packagedEntry of expectedPackageDistInventoryEntries) {
        if (!normalizedInventorySet.has(packagedEntry)) {
          errors.push(`inventory omits packaged dist file ${packagedEntry}`);
        }
      }
      packageDistImports = runPhase("dist import graph", () =>
        collectPackageDistImports({
          files: packageNormalized,
          readText: readPackageTarEntry,
        }),
      );
      for (const inventoryEntry of inventory) {
        const normalizedEntry = inventoryEntry.replace(/\\/gu, "/");
        if (!packageEntrySet.has(normalizedEntry)) {
          if (
            allowLegacyPrivateQaInventoryOmissions &&
            isLegacyOmittedPrivateQaInventoryEntry(normalizedEntry)
          ) {
            warnings.push(
              `legacy inventory references omitted private QA tar entry ${normalizedEntry}`,
            );
            continue;
          }
          errors.push(`inventory references missing tar entry ${normalizedEntry}`);
        }
      }
      const expandedInventory = expandPackageDistImportClosure({
        files: packageNormalized,
        seedFiles: normalizedInventory,
        readText: readPackageTarEntry,
        imports: packageDistImports,
      });
      for (const importedEntry of expandedInventory) {
        if (!normalizedInventorySet.has(importedEntry)) {
          errors.push(`inventory omits imported dist file ${importedEntry}`);
        }
      }
    }
  } catch (error) {
    errors.push(
      `unreadable dist/postinstall-inventory.json: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

if (packageEntrySet.has("dist/postinstall-content-inventory.json")) {
  try {
    const contentInventory = JSON.parse(
      readPackageMetadataTarEntry("dist/postinstall-content-inventory.json"),
    );
    if (
      !Array.isArray(contentInventory) ||
      contentInventory.some((entry) => !isContentInventoryEntry(entry))
    ) {
      errors.push("invalid dist/postinstall-content-inventory.json");
    } else {
      const normalizedContentEntries = contentInventory.map((entry) =>
        Object.assign({}, entry, { path: entry.path.replace(/\\/gu, "/") }),
      );
      const normalizedContentEntryCounts = new Map();
      for (const contentEntry of normalizedContentEntries) {
        normalizedContentEntryCounts.set(
          contentEntry.path,
          (normalizedContentEntryCounts.get(contentEntry.path) ?? 0) + 1,
        );
      }
      for (const [entry, count] of normalizedContentEntryCounts) {
        if (count > 1) {
          errors.push(`duplicate normalized content inventory entry: ${entry}`);
        }
      }
      const contentEntryMap = new Map(normalizedContentEntries.map((entry) => [entry.path, entry]));
      for (const packagedEntry of expectedPackageDistInventoryEntries) {
        if (!contentEntryMap.has(packagedEntry)) {
          errors.push(`content inventory omits packaged dist file ${packagedEntry}`);
        }
      }
      const normalizedInventorySet = normalizedInventory ? new Set(normalizedInventory) : null;
      if (normalizedInventory) {
        for (const inventoryEntry of normalizedInventory) {
          if (
            !contentEntryMap.has(inventoryEntry) &&
            !isAllowedMissingContentInventoryEntry(inventoryEntry)
          ) {
            errors.push(`content inventory omits packaged dist file ${inventoryEntry}`);
          }
        }
        for (const contentEntry of normalizedContentEntries) {
          if (!normalizedInventorySet?.has(contentEntry.path)) {
            errors.push(
              `content inventory references non-inventoried dist file ${contentEntry.path}`,
            );
          }
        }
      }
      for (const contentEntry of normalizedContentEntries) {
        if (!isSafeTarEntryPath(contentEntry.path)) {
          errors.push(`unsafe content inventory entry ${contentEntry.path}`);
          continue;
        }
        if (normalizedInventorySet && !normalizedInventorySet.has(contentEntry.path)) {
          continue;
        }
        if (!packageEntrySet.has(contentEntry.path)) {
          errors.push(`content inventory references missing tar entry ${contentEntry.path}`);
          continue;
        }
        const { content, error, mode } = readPackageTarEntryBuffer(contentEntry.path);
        if (error) {
          errors.push(error);
          continue;
        }
        if (!content) {
          errors.push(`content inventory references missing tar entry ${contentEntry.path}`);
          continue;
        }
        const actualHash = sha256Hex(content);
        if (actualHash !== contentEntry.sha256) {
          errors.push(`content inventory hash mismatch for ${contentEntry.path}`);
        }
        if (content.length !== contentEntry.size) {
          errors.push(`content inventory size mismatch for ${contentEntry.path}`);
        }
        if (process.platform !== "win32" && (mode & 0o111) !== (contentEntry.mode & 0o111)) {
          errors.push(`content inventory executable mode mismatch for ${contentEntry.path}`);
        }
      }
    }
  } catch (error) {
    errors.push(
      `unreadable dist/postinstall-content-inventory.json: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

errors.push(
  ...collectPackageDistImportErrors({
    files: packageNormalized,
    readText: readPackageTarEntry,
    imports: packageDistImports ?? undefined,
  }),
);

if (errors.length > 0) {
  fs.rmSync(extractDir, { recursive: true, force: true });
  fail(`OpenClaw package tarball integrity failed:\n${errors.join("\n")}`);
}

for (const warning of warnings) {
  console.warn(`OpenClaw package tarball integrity warning: ${warning}`);
}
fs.rmSync(extractDir, { recursive: true, force: true });
console.log("OpenClaw package tarball integrity passed.");
