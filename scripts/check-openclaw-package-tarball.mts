#!/usr/bin/env node
// Validates the npm tarball Docker E2E lanes install.
// This is intentionally tarball-only: the check proves Docker lanes consume the
// prebuilt package artifact with dist inventory, not a source checkout.
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { extract as extractTar, list as listTar, type ReadEntry } from "tar";
import { coerceErrorMessage } from "./lib/error-format.mts";
import { collectNpmPackInventory, compareNpmPackInventory } from "./lib/npm-pack-inventory.mts";
import { assertNpmShrinkwrapDependencies } from "./lib/npm-shrinkwrap-dependencies.mjs";
import { collectBundledDependencyErrors } from "./lib/package-bundled-dependencies.mts";
import { collectPackageDistImportErrors } from "./lib/package-dist-imports.mjs";
import {
  comparePackageDistInventory,
  comparePackageDistContentInventory,
  parsePackageDistContentInventory,
  PACKAGE_DIST_CONTENT_INVENTORY_RELATIVE_PATH,
  PACKAGE_DIST_INVENTORY_RELATIVE_PATH,
} from "./lib/package-dist-inventory-contract.mts";
import {
  LEGACY_PACKAGE_INSTALL_GUARD_RELATIVE_PATH,
  PACKAGE_LIFECYCLE_MARKER_CONTRACT_RELATIVE_PATH,
  PACKAGE_LIFECYCLE_PENDING_RELATIVE_PATH,
} from "./lib/package-lifecycle-marker.mjs";
import { collectForbiddenPackedPathErrors } from "./lib/packed-cargo-policy.mts";
import { isRecord } from "./lib/record-shared.mjs";
import { listPackagedStaticExtensionAssetOutputs } from "./lib/static-extension-assets.mts";
import { WORKSPACE_TEMPLATE_PACK_PATHS } from "./lib/workspace-bootstrap-smoke.mts";

type PackageManifest = Record<string, unknown> & {
  files?: unknown;
  scripts?: { postinstall?: unknown };
  version?: unknown;
};

type Calver = { day: number; month: number; year: number };

type ShrinkwrapPackage = {
  dev?: unknown;
  devDependencies?: unknown;
  name?: unknown;
  version?: unknown;
};

type ShrinkwrapManifest = {
  name?: unknown;
  packages?: Record<string, ShrinkwrapPackage>;
  version?: unknown;
};

function usage(): string {
  return "Usage: node scripts/check-openclaw-package-tarball.mjs [--require-bundled-workspace-deps] <openclaw.tgz>";
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function parseArgs(argv: string[]) {
  const args = argv[0] === "--" ? argv.slice(1) : argv;
  let requireBundledWorkspaceDeps = false;
  let tarball = "";
  for (const rawArg of args) {
    const arg = rawArg?.trim() ?? "";
    if (arg === "--help" || arg === "-h") {
      return { help: true, requireBundledWorkspaceDeps: false, tarball: "" };
    }
    if (arg === "--require-bundled-workspace-deps") {
      requireBundledWorkspaceDeps = true;
      continue;
    }
    if (arg.startsWith("-")) {
      throw new Error(`Unknown OpenClaw package tarball check option: ${arg}`);
    }
    if (tarball) {
      throw new Error(`Unexpected OpenClaw package tarball check argument: ${arg}`);
    }
    tarball = arg;
  }
  if (!tarball) {
    throw new Error(usage());
  }
  return { help: false, requireBundledWorkspaceDeps, tarball };
}

let cliArgs: ReturnType<typeof parseArgs>;
try {
  cliArgs = parseArgs(process.argv.slice(2));
} catch (error) {
  fail(coerceErrorMessage(error));
}
if (cliArgs.help) {
  console.log(usage());
  process.exit(0);
}

const { tarball } = cliArgs;
if (!fs.existsSync(tarball)) {
  fail(`OpenClaw package tarball does not exist: ${tarball}`);
}

const PACKAGE_DEPENDENCY_SECTIONS = [
  "dependencies",
  "optionalDependencies",
  "peerDependencies",
  "devDependencies",
] as const;
function collectWorkspaceProtocolDependencyErrors(packageJson: unknown, label: string): string[] {
  const errors: string[] = [];
  if (!packageJson || typeof packageJson !== "object") {
    return errors;
  }
  const packageRecord = packageJson as Record<string, unknown>;

  for (const section of PACKAGE_DEPENDENCY_SECTIONS) {
    const dependencies = packageRecord[section];
    if (!dependencies || typeof dependencies !== "object" || Array.isArray(dependencies)) {
      continue;
    }

    for (const [name, spec] of Object.entries(dependencies)) {
      if (typeof spec === "string" && spec.startsWith("workspace:")) {
        errors.push(`${label} ${section}.${name} must not use workspace protocol ${spec}`);
      }
    }
  }

  return errors;
}

function collectLocalPackageExportTargets(
  value: unknown,
  targets = new Set<string>(),
): Set<string> {
  if (typeof value === "string") {
    if (value.startsWith("./") && !value.includes("*")) {
      targets.add(value.slice(2));
    }
    return targets;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectLocalPackageExportTargets(entry, targets);
    }
    return targets;
  }
  if (isRecord(value)) {
    for (const entry of Object.values(value)) {
      collectLocalPackageExportTargets(entry, targets);
    }
  }
  return targets;
}

function collectPackageExportErrors(
  packageJson: PackageManifest,
  entries: ReadonlySet<string>,
): string[] {
  return [...collectLocalPackageExportTargets(packageJson.exports)]
    .filter((target) => !entries.has(target))
    .map((target) => `package.json export target is missing ${target}`);
}

function normalizePackageFilesEntry(value: unknown): string {
  return typeof value === "string"
    ? value
        .replaceAll("\\", "/")
        .trim()
        .replace(/^\.?\/+/u, "")
        .toLowerCase()
    : "";
}

function collectMissingDeclaredPackageFileErrors(
  packageJson: PackageManifest,
  entries: ReadonlySet<string>,
): string[] {
  if (!Array.isArray(packageJson.files)) {
    return [];
  }
  const available = [...entries].map((entry) => entry.replace(/\/+$/u, "").toLowerCase());
  return packageJson.files.flatMap((value) => {
    const declared = normalizePackageFilesEntry(value);
    if (!declared || declared.startsWith("!") || /[*?[\]{}()]/u.test(declared)) {
      return [];
    }
    const expected = declared.replace(/\/+$/u, "");
    return available.some((entry) => entry === expected || entry.startsWith(`${expected}/`))
      ? []
      : [`package.json declares missing tar entry ${expected}`];
  });
}

const phaseTimingsEnabled = process.env.OPENCLAW_PACKAGE_TARBALL_CHECK_TIMINGS !== "0";
const NPM_PACK_INVENTORY_TIMEOUT_MS = 5 * 60 * 1_000;
const NPM_PACK_DIAGNOSTIC_PATH_LIMIT = 20;
// npm 11 and 12 disagree on shrinkwrap packlist inclusion. Its dedicated
// validation below owns that contract independently of the host npm version.
const NPM_PACK_VERSION_VARIANT_PATHS = ["npm-shrinkwrap.json"] as const;
function runPhase<Result>(label: string, action: () => Result): Result {
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

type MaterialTarEntry = {
  kind: "directory" | "file";
  path: string;
};

function isRegularTarEntry(entry: ReadEntry): boolean {
  return entry.type === "File" || entry.type === "OldFile" || entry.type === "ContiguousFile";
}

function canonicalMaterialPath(entry: ReadEntry, errors: string[]): string | null {
  const rawPath = entry.header.path ?? "";
  const parseParts = (candidate: string): string[] | null => {
    const parts = candidate.split("/");
    if (
      !candidate ||
      candidate.includes("\\") ||
      candidate.startsWith("/") ||
      /^[A-Za-z]:/u.test(candidate) ||
      parts.some(
        (part, index) =>
          part === "." ||
          part === ".." ||
          (part === "" && index > 0 && !(entry.type === "Directory" && index === parts.length - 1)),
      )
    ) {
      return null;
    }
    if (entry.type === "Directory" && parts.at(-1) === "") {
      parts.pop();
    }
    return parts;
  };
  const rawParts = parseParts(rawPath);
  if (!rawParts) {
    errors.push(`unsafe tar entry path: ${rawPath || "<empty>"}`);
    return null;
  }
  const finalPath = entry.path;
  const parts = finalPath === rawPath ? rawParts : parseParts(finalPath);
  if (!parts) {
    errors.push(`unsafe tar entry path: ${finalPath || "<empty>"}`);
    return null;
  }
  if (parts[0] !== "package" || (parts.length === 1 && entry.type !== "Directory")) {
    errors.push(`tar entry is outside package/: ${finalPath || "<empty>"}`);
    return null;
  }
  return parts.join("/");
}

// tar@7.5.22 winchars.encode applies this mapping before Windows extraction.
function portableExtractionPathKey(value: string): string {
  return value
    .normalize("NFC")
    .replace(/[|<>?:]/gu, (char) => String.fromCodePoint(0xf000 + char.codePointAt(0)!))
    .toLowerCase();
}

function scanTarball(archivePath: string): {
  entries: string[];
  files: string[];
} {
  const errors: string[] = [];
  const materialEntries: MaterialTarEntry[] = [];
  const inspectEntry = (entry: ReadEntry) => {
    const rawPath = entry.header.path ?? entry.path;
    const isFile = isRegularTarEntry(entry);
    if ((!isFile && entry.type !== "Directory") || Boolean(entry.linkpath)) {
      errors.push(`unsupported tar entry type ${entry.type}: ${rawPath}`);
      return;
    }
    const materialPath = canonicalMaterialPath(entry, errors);
    if (!materialPath) {
      return;
    }
    const mode = entry.mode;
    const needsExec = entry.type === "Directory" || (mode !== undefined && (mode & 0o111) !== 0);
    if (mode === undefined || (mode & 0o444) !== 0o444 || (needsExec && (mode & 0o111) !== 0o111)) {
      errors.push(
        `tar entry is not world-readable (${mode === undefined ? "<missing>" : `0${mode.toString(8)}`}): ${rawPath}`,
      );
    }
    materialEntries.push({
      kind: isFile ? "file" : "directory",
      path: materialPath,
    });
  };

  runPhase("tar preflight", () => {
    let parseError: Error | undefined;
    const parser = listTar({ sync: true, strict: true, onReadEntry: inspectEntry });
    parser.on("ignoredEntry", inspectEntry);
    parser.on("error", (error: Error) => {
      parseError ??= error;
    });
    const input = fs.openSync(archivePath, "r");
    const chunk = Buffer.allocUnsafe(64 * 1024);
    try {
      let bytesRead = 0;
      while ((bytesRead = fs.readSync(input, chunk, 0, chunk.length, null)) > 0) {
        parser.write(chunk.subarray(0, bytesRead));
        if (parseError) {
          break;
        }
      }
      if (!parseError) {
        parser.end();
      }
    } finally {
      fs.closeSync(input);
    }
    if (parseError) {
      throw parseError;
    }
  });

  const exactPaths = new Map<string, MaterialTarEntry>();
  const portablePaths = new Map<string, MaterialTarEntry>();
  for (const entry of materialEntries) {
    const existing = exactPaths.get(entry.path);
    if (existing) {
      errors.push(
        existing.kind === entry.kind
          ? `package tarball contains duplicate paths: ${entry.path}`
          : `package tarball contains file-directory conflict: ${entry.path}`,
      );
    } else {
      exactPaths.set(entry.path, entry);
    }
    const portablePath = portableExtractionPathKey(entry.path);
    const portableExisting = portablePaths.get(portablePath);
    if (portableExisting && portableExisting.path !== entry.path) {
      errors.push(
        `package tarball contains portable path collision: ${portableExisting.path}, ${entry.path}`,
      );
    } else {
      portablePaths.set(portablePath, entry);
    }
  }
  for (const entry of exactPaths.values()) {
    const parts = entry.path.split("/");
    for (let index = 1; index < parts.length; index += 1) {
      const ancestor = portablePaths.get(
        portableExtractionPathKey(parts.slice(0, index).join("/")),
      );
      if (ancestor?.kind === "file") {
        errors.push(
          `package tarball contains file-ancestor conflict: ${ancestor.path}, ${entry.path}`,
        );
        break;
      }
    }
  }
  const packageManifests = materialEntries.filter(
    (entry) => entry.path === "package/package.json" && entry.kind === "file",
  );
  if (packageManifests.length !== 1) {
    errors.push(
      `package tarball must contain exactly one regular package/package.json (found ${packageManifests.length})`,
    );
  }
  if (errors.length > 0) {
    throw new Error(errors.join("\n"));
  }

  return {
    entries: [...exactPaths.values()]
      .filter((entry) => entry.path !== "package")
      .map((entry) => {
        const relativePath = entry.path.slice("package/".length);
        return entry.kind === "directory" ? `${relativePath}/` : relativePath;
      }),
    files: [...exactPaths.values()]
      .filter((entry) => entry.kind === "file")
      .map((entry) => entry.path.slice("package/".length)),
  };
}

const archiveRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-package-tarball-"));
const archiveSnapshot = path.join(archiveRoot, "candidate.tgz");
const extractDir = path.join(archiveRoot, "extract");
let normalized: string[];
let tarFileEntries: string[];
try {
  // Both passes consume one private byte snapshot, so path replacement cannot
  // make preflight approve different bytes than extraction materializes.
  fs.chmodSync(archiveRoot, 0o700);
  fs.copyFileSync(tarball, archiveSnapshot, fs.constants.COPYFILE_EXCL);
  fs.chmodSync(archiveSnapshot, 0o400);
  ({ entries: normalized, files: tarFileEntries } = scanTarball(archiveSnapshot));
  fs.mkdirSync(extractDir);
  runPhase("tar extract", () =>
    extractTar({
      cwd: extractDir,
      file: archiveSnapshot,
      preserveOwner: false,
      strict: true,
      sync: true,
    }),
  );
} catch (error) {
  fs.rmSync(archiveRoot, { recursive: true, force: true });
  fail(`OpenClaw package tarball preflight failed:\n${coerceErrorMessage(error)}`);
}
const entrySet = new Set(normalized);
const errors: string[] = [];
const warnings: string[] = [];
const LEGACY_CODE_MODE_WORKER_PATH = "dist/agents/code-mode.worker.js";
const CODE_MODE_WORKER_PATH = "dist/agents/code-mode-node.worker.js";
const REQUIRED_TARBALL_ENTRIES = ["dist/control-ui/index.html", ...WORKSPACE_TEMPLATE_PACK_PATHS];
const REQUIRED_TARBALL_ENTRY_PREFIXES = ["dist/control-ui/assets/"];
// 2026.8.1 shipped the old dist guard. Historical inspection must still accept it.
const LEGACY_LIFECYCLE_MARKER_COMPAT_MAX = { year: 2026, month: 8, day: 1 };

function parseCalver(version: string): Calver | null {
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

function compareCalver(left: Calver, right: Calver): number {
  for (const key of ["year", "month", "day"] as const) {
    if (left[key] !== right[key]) {
      return left[key] - right[key];
    }
  }
  return 0;
}

function isLegacyLifecycleMarkerCompatVersion(version: string): boolean {
  const parsed = parseCalver(version);
  return parsed ? compareCalver(parsed, LEGACY_LIFECYCLE_MARKER_COMPAT_MAX) <= 0 : false;
}

function readTarEntry(entryPath: string): string {
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

const extractedPackageRoot = fs.realpathSync(
  fs.existsSync(path.join(extractDir, "package", "package.json"))
    ? path.join(extractDir, "package")
    : extractDir,
);

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
let packageJson: PackageManifest | null = null;
if (entrySet.has("package.json")) {
  try {
    packageJson = JSON.parse(readTarEntry("package.json")) as PackageManifest;
    packageVersion = typeof packageJson.version === "string" ? packageJson.version : "";
    errors.push(...collectWorkspaceProtocolDependencyErrors(packageJson, "package.json"));
    errors.push(
      ...collectBundledDependencyErrors({
        packageJson,
        entries: entrySet,
        files: normalized,
        packageRoot: extractedPackageRoot,
        readText: readTarEntry,
        requireBundledWorkspaceDeps: cliArgs.requireBundledWorkspaceDeps,
      }),
    );
  } catch {
    packageVersion = "";
  }
}
if (packageJson) {
  errors.push(...collectMissingDeclaredPackageFileErrors(packageJson, new Set(tarFileEntries)));
  errors.push(...collectPackageExportErrors(packageJson, entrySet));
  try {
    for (const assetPath of listPackagedStaticExtensionAssetOutputs({
      rootDir: extractedPackageRoot,
    })) {
      if (!entrySet.has(assetPath)) {
        errors.push(`declared static extension asset is missing: ${assetPath}`);
      }
    }
  } catch (error) {
    errors.push(`unreadable packaged extension asset metadata: ${coerceErrorMessage(error)}`);
  }
}
errors.push(...collectForbiddenPackedPathErrors(normalized));
// Published packages before executor plugins retain the original QuickJS worker.
const codeModeWorkerPath =
  isRecord(packageJson?.exports) &&
  Object.hasOwn(packageJson.exports, "./plugin-sdk/code-mode-executor-runtime")
    ? CODE_MODE_WORKER_PATH
    : LEGACY_CODE_MODE_WORKER_PATH;
if (!entrySet.has(codeModeWorkerPath)) {
  errors.push(`missing required tar entry ${codeModeWorkerPath}`);
}
const hasShrinkwrap = entrySet.has("npm-shrinkwrap.json");
const declaresShrinkwrap =
  Array.isArray(packageJson?.files) &&
  packageJson.files.some((entry) => normalizePackageFilesEntry(entry) === "npm-shrinkwrap.json");
if (hasShrinkwrap && !declaresShrinkwrap) {
  errors.push("package tarball must not contain npm-shrinkwrap.json");
}
if (hasShrinkwrap && declaresShrinkwrap) {
  try {
    const shrinkwrap = JSON.parse(readTarEntry("npm-shrinkwrap.json")) as ShrinkwrapManifest;
    assertNpmShrinkwrapDependencies(packageJson, shrinkwrap);
    const rootPackage = shrinkwrap.packages?.[""];
    if (shrinkwrap.name !== "openclaw") {
      errors.push("npm-shrinkwrap.json root name must be openclaw");
    }
    if (shrinkwrap.version !== packageVersion) {
      const shrinkwrapVersion =
        typeof shrinkwrap.version === "string" ? shrinkwrap.version : "<missing>";
      errors.push(
        `npm-shrinkwrap.json version ${shrinkwrapVersion} does not match package.json version ${packageVersion || "<missing>"}`,
      );
    }
    if (!rootPackage || rootPackage.name !== "openclaw") {
      errors.push("npm-shrinkwrap.json packages root must name openclaw");
    }
    if (rootPackage?.version !== packageVersion) {
      const rootPackageVersion =
        typeof rootPackage?.version === "string" ? rootPackage.version : "<missing>";
      errors.push(
        `npm-shrinkwrap.json packages root version ${rootPackageVersion} does not match package.json version ${packageVersion || "<missing>"}`,
      );
    }
    if (rootPackage?.devDependencies) {
      errors.push("npm-shrinkwrap.json must not lock root devDependencies");
    }
    errors.push(
      ...collectWorkspaceProtocolDependencyErrors(rootPackage, "npm-shrinkwrap.json packages root"),
    );
    const devLockedPackages = Object.entries(shrinkwrap.packages ?? {})
      .filter(([, packageMetadata]) => packageMetadata?.dev === true)
      .map(([packagePath]) => packagePath);
    if (devLockedPackages.length > 0) {
      errors.push(
        `npm-shrinkwrap.json must not lock dev packages: ${devLockedPackages.slice(0, 5).join(", ")}`,
      );
    }
  } catch (error) {
    errors.push(`unreadable npm-shrinkwrap.json: ${coerceErrorMessage(error)}`);
  }
}

try {
  const npmInventory = collectNpmPackInventory(extractedPackageRoot, {
    timeoutMs: NPM_PACK_INVENTORY_TIMEOUT_MS,
  });
  if (phaseTimingsEnabled) {
    console.error(
      `check-openclaw-package-tarball: npm pack inventory (npm ${npmInventory.npmVersion}) completed in ${npmInventory.durationMs}ms`,
    );
  }
  const { extra, missing } = compareNpmPackInventory(
    tarFileEntries,
    npmInventory.files,
    NPM_PACK_VERSION_VARIANT_PATHS,
  );
  const describePaths = (paths: string[]): string => {
    const examples = paths.slice(0, NPM_PACK_DIAGNOSTIC_PATH_LIMIT).join(", ");
    const omitted = paths.length - NPM_PACK_DIAGNOSTIC_PATH_LIMIT;
    return omitted > 0 ? `${examples} (+${omitted} more)` : examples;
  };
  if (missing.length > 0) {
    errors.push(`package tarball is missing npm-selected entries: ${describePaths(missing)}`);
  }
  if (extra.length > 0) {
    errors.push(`package tarball contains npm-excluded entries: ${describePaths(extra)}`);
  }
} catch (error) {
  errors.push(`npm pack inventory failed: ${coerceErrorMessage(error)}`);
}
const usesPackageLifecycleMarker = entrySet.has(PACKAGE_LIFECYCLE_MARKER_CONTRACT_RELATIVE_PATH);
if (entrySet.has(PACKAGE_LIFECYCLE_PENDING_RELATIVE_PATH) && !usesPackageLifecycleMarker) {
  errors.push(`missing required tar entry ${PACKAGE_LIFECYCLE_MARKER_CONTRACT_RELATIVE_PATH}`);
}
if (!entrySet.has(PACKAGE_LIFECYCLE_PENDING_RELATIVE_PATH)) {
  if (!usesPackageLifecycleMarker && isLegacyLifecycleMarkerCompatVersion(packageVersion)) {
    warnings.push("legacy package omits the lifecycle pending marker");
  } else {
    errors.push(`missing required tar entry ${PACKAGE_LIFECYCLE_PENDING_RELATIVE_PATH}`);
  }
}
if (
  entrySet.has(LEGACY_PACKAGE_INSTALL_GUARD_RELATIVE_PATH) &&
  (usesPackageLifecycleMarker || !isLegacyLifecycleMarkerCompatVersion(packageVersion))
) {
  errors.push(`forbidden legacy tar entry ${LEGACY_PACKAGE_INSTALL_GUARD_RELATIVE_PATH}`);
}
if (!entrySet.has(PACKAGE_DIST_INVENTORY_RELATIVE_PATH)) {
  errors.push(`missing ${PACKAGE_DIST_INVENTORY_RELATIVE_PATH}`);
}
if (entrySet.has(PACKAGE_DIST_INVENTORY_RELATIVE_PATH)) {
  try {
    const inventory = JSON.parse(readTarEntry(PACKAGE_DIST_INVENTORY_RELATIVE_PATH));
    if (!Array.isArray(inventory) || inventory.some((entry) => typeof entry !== "string")) {
      errors.push(`invalid ${PACKAGE_DIST_INVENTORY_RELATIVE_PATH}`);
    } else {
      const inventoryEntries = inventory as string[];
      if (entrySet.has(PACKAGE_DIST_CONTENT_INVENTORY_RELATIVE_PATH)) {
        const expected = parsePackageDistContentInventory(
          JSON.parse(readTarEntry(PACKAGE_DIST_CONTENT_INVENTORY_RELATIVE_PATH)),
        );
        const actual = inventoryEntries
          .filter((entry) => entry !== PACKAGE_DIST_CONTENT_INVENTORY_RELATIVE_PATH)
          .map((entry) => {
            if (!entrySet.has(entry) || !entry.startsWith("dist/")) {
              throw new Error(`Inventory references absent tar entry ${entry}`);
            }
            const file = path.join(extractedPackageRoot, entry);
            const bytes = fs.readFileSync(file);
            return {
              path: entry,
              sha256: createHash("sha256").update(bytes).digest("hex"),
              size: bytes.length,
              mode: fs.statSync(file).mode & 0o777,
            };
          });
        errors.push(...comparePackageDistContentInventory(expected, actual));
      }

      const parity = comparePackageDistInventory({
        files: normalized.filter(
          (entry) =>
            entry.startsWith("dist/") &&
            fs.statSync(path.join(extractedPackageRoot, entry)).isFile(),
        ),
        inventory: inventoryEntries,
      });
      if (typeof packageJson?.scripts?.postinstall === "string") {
        for (const missingEntry of parity.packagedFilesMissingFromInventory) {
          errors.push(`postinstall inventory omits packaged dist file ${missingEntry}`);
        }
      }
      for (const missingEntry of parity.inventoryEntriesMissingFromPackage) {
        errors.push(`inventory references missing tar entry ${missingEntry}`);
      }
    }
  } catch (error) {
    errors.push(`unreadable ${PACKAGE_DIST_INVENTORY_RELATIVE_PATH}: ${coerceErrorMessage(error)}`);
  }
}

errors.push(
  ...runPhase("dist import graph", () =>
    collectPackageDistImportErrors({ files: normalized, readText: readTarEntry }),
  ),
);

if (errors.length > 0) {
  fs.rmSync(archiveRoot, { recursive: true, force: true });
  fail(`OpenClaw package tarball integrity failed:\n${errors.join("\n")}`);
}

for (const warning of warnings) {
  console.warn(`OpenClaw package tarball integrity warning: ${warning}`);
}
fs.rmSync(archiveRoot, { recursive: true, force: true });
console.log("OpenClaw package tarball integrity passed.");
