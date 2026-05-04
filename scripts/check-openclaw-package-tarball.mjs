#!/usr/bin/env node
// Validates the npm tarball Docker E2E lanes install.
// This is intentionally tarball-only: the check proves Docker lanes consume the
// prebuilt package artifact with dist inventory, not a source checkout.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
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

const tarball = process.argv[2];
if (!tarball || process.argv.length > 3) {
  fail(usage());
}
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
const normalized = entries.map((entry) => entry.replace(/^package\//u, ""));
const entrySet = new Set(normalized);
const errors = [];
const warnings = [];
const REQUIRED_TARBALL_ENTRIES = ["dist/control-ui/index.html"];
const REQUIRED_TARBALL_ENTRY_PREFIXES = ["dist/control-ui/assets/"];
const LEGACY_PACKAGE_ACCEPTANCE_COMPAT_MAX = { year: 2026, month: 4, day: 25 };
const LEGACY_LOCAL_BUILD_METADATA_COMPAT_MAX = { year: 2026, month: 4, day: 26 };
const FORBIDDEN_LOCAL_BUILD_METADATA_FILES = new Set(LOCAL_BUILD_METADATA_DIST_PATHS);

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

function readTarEntry(entryPath) {
  const candidates = [
    path.join(extractDir, entryPath),
    path.join(extractDir, "package", entryPath),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return fs.readFileSync(candidate, "utf8");
    }
  }
  return "";
}

function collectRootPackageExcludedExtensionDirs(packageJson) {
  /** @type {Set<string>} */
  const excluded = new Set();
  for (const entry of packageJson.files ?? []) {
    if (typeof entry !== "string") {
      continue;
    }
    const match = /^!dist\/extensions\/([^/]+)\/\*\*$/u.exec(entry);
    if (match?.[1]) {
      excluded.add(match[1]);
    }
  }
  return excluded;
}

function collectExternalizedPluginRootChunkErrors(packageJson) {
  const excludedExtensionDirs = collectRootPackageExcludedExtensionDirs(packageJson);
  if (excludedExtensionDirs.size === 0) {
    return [];
  }
  /** @type {Map<string, string[]>} */
  const leaked = new Map();
  for (const entry of normalized) {
    if (
      !entry.startsWith("dist/") ||
      entry.startsWith("dist/extensions/") ||
      !/\.(?:cjs|js|mjs)$/u.test(entry)
    ) {
      continue;
    }
    const source = readTarEntry(entry);
    for (const pluginId of excludedExtensionDirs) {
      if (source.includes(`//#region extensions/${pluginId}/`)) {
        const files = leaked.get(pluginId) ?? [];
        files.push(entry);
        leaked.set(pluginId, files);
      }
    }
  }
  return [...leaked.entries()]
    .map(([pluginId, files]) => {
      const fileList = [...new Set(files)].toSorted((left, right) => left.localeCompare(right));
      return `root dist contains code from externalized plugin '${pluginId}' in ${fileList.join(", ")}; excluded plugins must not be compiled into root package chunks.`;
    })
    .toSorted((left, right) => left.localeCompare(right));
}

for (const entry of normalized) {
  if (entry.startsWith("/") || entry.split("/").includes("..")) {
    errors.push(`unsafe tar entry: ${entry}`);
  }
}

if (!entrySet.has("package.json")) {
  errors.push("missing package.json");
}
if (!normalized.some((entry) => entry.startsWith("dist/"))) {
  errors.push("missing dist/ entries");
}
for (const requiredEntry of REQUIRED_TARBALL_ENTRIES) {
  if (!entrySet.has(requiredEntry)) {
    errors.push(`missing required tar entry ${requiredEntry}`);
  }
}
for (const requiredPrefix of REQUIRED_TARBALL_ENTRY_PREFIXES) {
  if (!normalized.some((entry) => entry.startsWith(requiredPrefix))) {
    errors.push(`missing required tar entries under ${requiredPrefix}`);
  }
}
let packageVersion = "";
let packageJson = {};
if (entrySet.has("package.json")) {
  try {
    packageJson = JSON.parse(readTarEntry("package.json"));
    packageVersion = typeof packageJson.version === "string" ? packageJson.version : "";
  } catch {
    packageVersion = "";
  }
}
errors.push(...collectExternalizedPluginRootChunkErrors(packageJson));
for (const forbiddenEntry of FORBIDDEN_LOCAL_BUILD_METADATA_FILES) {
  if (entrySet.has(forbiddenEntry)) {
    if (isLegacyLocalBuildMetadataCompatVersion(packageVersion)) {
      warnings.push(`legacy package includes local build metadata tar entry ${forbiddenEntry}`);
      continue;
    }
    errors.push(`forbidden local build metadata tar entry ${forbiddenEntry}`);
  }
}
if (!entrySet.has("dist/postinstall-inventory.json")) {
  errors.push("missing dist/postinstall-inventory.json");
}
let packageDistImports = null;
if (entrySet.has("dist/postinstall-inventory.json")) {
  try {
    const allowLegacyPrivateQaInventoryOmissions =
      isLegacyPackageAcceptanceCompatVersion(packageVersion);
    const inventory = JSON.parse(readTarEntry("dist/postinstall-inventory.json"));
    if (!Array.isArray(inventory) || inventory.some((entry) => typeof entry !== "string")) {
      errors.push("invalid dist/postinstall-inventory.json");
    } else {
      const normalizedInventory = inventory.map((entry) => entry.replace(/\\/gu, "/"));
      const normalizedInventorySet = new Set(normalizedInventory);
      packageDistImports = runPhase("dist import graph", () =>
        collectPackageDistImports({
          files: normalized,
          readText: readTarEntry,
        }),
      );
      for (const inventoryEntry of inventory) {
        const normalizedEntry = inventoryEntry.replace(/\\/gu, "/");
        if (!entrySet.has(normalizedEntry)) {
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
        files: normalized,
        seedFiles: normalizedInventory,
        readText: readTarEntry,
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

errors.push(
  ...collectPackageDistImportErrors({
    files: normalized,
    readText: readTarEntry,
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
