#!/usr/bin/env -S node --import tsx

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { pathToFileURL } from "node:url";

type PackageJson = {
  name?: string;
  version?: string;
  description?: string;
  license?: string;
  repository?: { url?: string } | string;
  bin?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
};

export type ParsedReleaseVersion = {
  version: string;
  baseVersion: string;
  channel: "stable" | "beta";
  year: number;
  month: number;
  day: number;
  betaNumber?: number;
  correctionNumber?: number;
  date: Date;
};

export type ParsedReleaseTag = {
  version: string;
  packageVersion: string;
  baseVersion: string;
  channel: "stable" | "beta";
  correctionNumber?: number;
  date: Date;
};

const STABLE_VERSION_REGEX = /^(?<year>\d{4})\.(?<month>[1-9]\d?)\.(?<day>[1-9]\d?)$/;
const BETA_VERSION_REGEX =
  /^(?<year>\d{4})\.(?<month>[1-9]\d?)\.(?<day>[1-9]\d?)-beta\.(?<beta>[1-9]\d*)$/;
const CORRECTION_VERSION_REGEX =
  /^(?<year>\d{4})\.(?<month>[1-9]\d?)\.(?<day>[1-9]\d?)-(?<correction>[1-9]\d*)$/;
const EXPECTED_REPOSITORY_URL = "https://github.com/openclaw/openclaw";
const MAX_CALVER_DISTANCE_DAYS = 2;
const REQUIRED_PACKED_PATHS = ["dist/control-ui/index.html"];
const CONTROL_UI_ASSET_PREFIX = "dist/control-ui/assets/";
const NPM_PACK_MAX_BUFFER_BYTES = 64 * 1024 * 1024;

function normalizeRepoUrl(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }

  return value
    .trim()
    .replace(/^git\+/, "")
    .replace(/\.git$/i, "")
    .replace(/\/+$/, "");
}

function parseDateParts(
  version: string,
  groups: Record<string, string | undefined>,
  channel: "stable" | "beta",
): ParsedReleaseVersion | null {
  const year = Number.parseInt(groups.year ?? "", 10);
  const month = Number.parseInt(groups.month ?? "", 10);
  const day = Number.parseInt(groups.day ?? "", 10);
  const betaNumber = channel === "beta" ? Number.parseInt(groups.beta ?? "", 10) : undefined;

  if (
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    !Number.isInteger(day) ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31
  ) {
    return null;
  }
  if (channel === "beta" && (!Number.isInteger(betaNumber) || (betaNumber ?? 0) < 1)) {
    return null;
  }

  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }

  return {
    version,
    baseVersion: `${year}.${month}.${day}`,
    channel,
    year,
    month,
    day,
    betaNumber,
    date,
  };
}

export function parseReleaseVersion(version: string): ParsedReleaseVersion | null {
  const trimmed = version.trim();
  if (!trimmed) {
    return null;
  }

  const stableMatch = STABLE_VERSION_REGEX.exec(trimmed);
  if (stableMatch?.groups) {
    return parseDateParts(trimmed, stableMatch.groups, "stable");
  }

  const betaMatch = BETA_VERSION_REGEX.exec(trimmed);
  if (betaMatch?.groups) {
    return parseDateParts(trimmed, betaMatch.groups, "beta");
  }

  const correctionMatch = CORRECTION_VERSION_REGEX.exec(trimmed);
  if (correctionMatch?.groups) {
    const parsedCorrection = parseDateParts(trimmed, correctionMatch.groups, "stable");
    const correctionNumber = Number.parseInt(correctionMatch.groups.correction ?? "", 10);
    if (parsedCorrection === null || !Number.isInteger(correctionNumber) || correctionNumber < 1) {
      return null;
    }

    return {
      ...parsedCorrection,
      correctionNumber,
    };
  }

  return null;
}

export function parseReleaseTagVersion(version: string): ParsedReleaseTag | null {
  const trimmed = version.trim();
  if (!trimmed) {
    return null;
  }

  const parsedVersion = parseReleaseVersion(trimmed);
  if (parsedVersion !== null) {
    return {
      version: trimmed,
      packageVersion: parsedVersion.version,
      baseVersion: parsedVersion.baseVersion,
      channel: parsedVersion.channel,
      date: parsedVersion.date,
      correctionNumber: parsedVersion.correctionNumber,
    };
  }

  return null;
}

function startOfUtcDay(date: Date): number {
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

export function utcCalendarDayDistance(left: Date, right: Date): number {
  return Math.round(Math.abs(startOfUtcDay(left) - startOfUtcDay(right)) / 86_400_000);
}

export function collectReleasePackageMetadataErrors(pkg: PackageJson): string[] {
  const actualRepositoryUrl = normalizeRepoUrl(
    typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url,
  );
  const errors: string[] = [];

  if (pkg.name !== "openclaw") {
    errors.push(`package.json name must be "openclaw"; found "${pkg.name ?? ""}".`);
  }
  if (!pkg.description?.trim()) {
    errors.push("package.json description must be non-empty.");
  }
  if (pkg.license !== "MIT") {
    errors.push(`package.json license must be "MIT"; found "${pkg.license ?? ""}".`);
  }
  if (actualRepositoryUrl !== EXPECTED_REPOSITORY_URL) {
    errors.push(
      `package.json repository.url must resolve to ${EXPECTED_REPOSITORY_URL}; found ${
        actualRepositoryUrl || "<missing>"
      }.`,
    );
  }
  if (pkg.bin?.openclaw !== "openclaw.mjs") {
    errors.push(
      `package.json bin.openclaw must be "openclaw.mjs"; found "${pkg.bin?.openclaw ?? ""}".`,
    );
  }
  if (pkg.peerDependencies?.["node-llama-cpp"] !== "3.18.1") {
    errors.push(
      `package.json peerDependencies["node-llama-cpp"] must be "3.18.1"; found "${
        pkg.peerDependencies?.["node-llama-cpp"] ?? ""
      }".`,
    );
  }
  if (pkg.peerDependenciesMeta?.["node-llama-cpp"]?.optional !== true) {
    errors.push('package.json peerDependenciesMeta["node-llama-cpp"].optional must be true.');
  }

  return errors;
}

export function collectReleaseTagErrors(params: {
  packageVersion: string;
  releaseTag: string;
  releaseSha?: string;
  releaseMainRef?: string;
  now?: Date;
}): string[] {
  const errors: string[] = [];
  const releaseTag = params.releaseTag.trim();
  const packageVersion = params.packageVersion.trim();
  const now = params.now ?? new Date();

  const parsedVersion = parseReleaseVersion(packageVersion);
  if (parsedVersion === null) {
    errors.push(
      `package.json version must match YYYY.M.D, YYYY.M.D-N, or YYYY.M.D-beta.N; found "${packageVersion || "<missing>"}".`,
    );
  }

  if (!releaseTag.startsWith("v")) {
    errors.push(`Release tag must start with "v"; found "${releaseTag || "<missing>"}".`);
  }

  const tagVersion = releaseTag.startsWith("v") ? releaseTag.slice(1) : releaseTag;
  const parsedTag = parseReleaseTagVersion(tagVersion);
  if (parsedTag === null) {
    errors.push(
      `Release tag must match vYYYY.M.D, vYYYY.M.D-beta.N, or fallback correction tag vYYYY.M.D-N; found "${releaseTag || "<missing>"}".`,
    );
  }

  const expectedTag = packageVersion ? `v${packageVersion}` : "<missing>";
  const matchesExpectedTag =
    parsedTag !== null &&
    parsedVersion !== null &&
    parsedTag.channel === parsedVersion.channel &&
    (parsedTag.packageVersion === parsedVersion.version ||
      (parsedVersion.channel === "stable" &&
        parsedVersion.correctionNumber === undefined &&
        parsedTag.correctionNumber !== undefined &&
        parsedTag.baseVersion === parsedVersion.baseVersion));
  if (!matchesExpectedTag) {
    errors.push(
      `Release tag ${releaseTag || "<missing>"} does not match package.json version ${
        packageVersion || "<missing>"
      }; expected ${
        parsedVersion?.channel === "stable" && parsedVersion.correctionNumber === undefined
          ? `${expectedTag} or ${expectedTag}-N`
          : expectedTag
      }.`,
    );
  }

  if (parsedVersion !== null) {
    const dayDistance = utcCalendarDayDistance(parsedVersion.date, now);
    if (dayDistance > MAX_CALVER_DISTANCE_DAYS) {
      const nowLabel = now.toISOString().slice(0, 10);
      const versionDate = parsedVersion.date.toISOString().slice(0, 10);
      errors.push(
        `Release version ${packageVersion} is ${dayDistance} days away from current UTC date ${nowLabel}; release CalVer date ${versionDate} must be within ${MAX_CALVER_DISTANCE_DAYS} days.`,
      );
    }
  }

  if (params.releaseSha?.trim() && params.releaseMainRef?.trim()) {
    try {
      execFileSync(
        "git",
        ["merge-base", "--is-ancestor", params.releaseSha, params.releaseMainRef],
        { stdio: "ignore" },
      );
    } catch {
      errors.push(
        `Tagged commit ${params.releaseSha} is not contained in ${params.releaseMainRef}.`,
      );
    }
  }

  return errors;
}

function loadPackageJson(): PackageJson {
  return JSON.parse(readFileSync("package.json", "utf8")) as PackageJson;
}

function isNpmExecPath(value: string): boolean {
  return /^npm(?:-cli)?(?:\.(?:c?js|cmd|exe))?$/.test(basename(value).toLowerCase());
}

export function resolveNpmCommandInvocation(
  params: {
    npmExecPath?: string;
    nodeExecPath?: string;
    platform?: NodeJS.Platform;
  } = {},
): { command: string; args: string[] } {
  const npmExecPath = params.npmExecPath ?? process.env.npm_execpath;
  const nodeExecPath = params.nodeExecPath ?? process.execPath;
  const npmCommand = (params.platform ?? process.platform) === "win32" ? "npm.cmd" : "npm";

  if (typeof npmExecPath === "string" && npmExecPath.length > 0 && isNpmExecPath(npmExecPath)) {
    return { command: nodeExecPath, args: [npmExecPath] };
  }

  return { command: npmCommand, args: [] };
}

function runNpmCommand(args: string[]): string {
  const invocation = resolveNpmCommandInvocation();
  return execFileSync(invocation.command, [...invocation.args, ...args], {
    encoding: "utf8",
    maxBuffer: NPM_PACK_MAX_BUFFER_BYTES,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

type NpmPackFileEntry = {
  path?: string;
};

type NpmPackResult = {
  filename?: string;
  files?: NpmPackFileEntry[];
};

type ExecFailure = Error & {
  stderr?: string | Uint8Array;
  stdout?: string | Uint8Array;
};

function toTrimmedUtf8(value: string | Uint8Array | undefined): string {
  if (typeof value === "string") {
    return value.trim();
  }
  if (value instanceof Uint8Array) {
    return new TextDecoder().decode(value).trim();
  }
  return "";
}

function describeExecFailure(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }
  const withStreams = error as ExecFailure;
  const details: string[] = [error.message];
  const stderr = toTrimmedUtf8(withStreams.stderr);
  const stdout = toTrimmedUtf8(withStreams.stdout);
  if (stderr) {
    details.push(`stderr: ${stderr}`);
  }
  if (stdout) {
    details.push(`stdout: ${stdout}`);
  }
  return details.join(" | ");
}

export function parseNpmPackJsonOutput(stdout: string): NpmPackResult[] | null {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return null;
  }

  const candidates = [trimmed];
  const trailingArrayStart = trimmed.lastIndexOf("\n[");
  if (trailingArrayStart !== -1) {
    candidates.push(trimmed.slice(trailingArrayStart + 1).trim());
  }

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (Array.isArray(parsed)) {
        return parsed as NpmPackResult[];
      }
    } catch {
      // Try the next candidate. npm lifecycle output can prepend non-JSON logs.
    }
  }

  return null;
}

export function collectControlUiPackErrors(paths: Iterable<string>): string[] {
  const packedPaths = new Set(paths);
  const assetPaths = [...packedPaths].filter((path) => path.startsWith(CONTROL_UI_ASSET_PREFIX));
  const errors: string[] = [];

  for (const requiredPath of REQUIRED_PACKED_PATHS) {
    if (!packedPaths.has(requiredPath)) {
      errors.push(
        `npm package is missing required path "${requiredPath}". Ensure UI assets are built and included before publish.`,
      );
    }
  }

  if (assetPaths.length === 0) {
    errors.push(
      `npm package is missing Control UI asset payload under "${CONTROL_UI_ASSET_PREFIX}". Refuse release when the dashboard tarball would be empty.`,
    );
  }

  return errors;
}

function collectPackedTarballErrors(): string[] {
  const errors: string[] = [];
  let stdout = "";
  try {
    stdout = runNpmCommand(["pack", "--json", "--dry-run"]);
  } catch (error) {
    const message = describeExecFailure(error);
    errors.push(
      `Failed to inspect npm tarball contents via \`npm pack --json --dry-run\`: ${message}`,
    );
    return errors;
  }

  const packResults = parseNpmPackJsonOutput(stdout);
  if (!packResults) {
    errors.push("Failed to parse JSON output from `npm pack --json --dry-run`.");
    return errors;
  }
  const firstResult = packResults[0];
  if (!firstResult || !Array.isArray(firstResult.files)) {
    errors.push("`npm pack --json --dry-run` did not return a files list to validate.");
    return errors;
  }

  const packedPaths = new Set(
    firstResult.files
      .map((entry) => entry.path)
      .filter((path): path is string => typeof path === "string" && path.length > 0),
  );

  return collectControlUiPackErrors(packedPaths);
}

function main(): number {
  const pkg = loadPackageJson();
  const now = new Date();
  const metadataErrors = collectReleasePackageMetadataErrors(pkg);
  const tagErrors = collectReleaseTagErrors({
    packageVersion: pkg.version ?? "",
    releaseTag: process.env.RELEASE_TAG ?? "",
    releaseSha: process.env.RELEASE_SHA,
    releaseMainRef: process.env.RELEASE_MAIN_REF,
    now,
  });
  const tarballErrors = collectPackedTarballErrors();
  const errors = [...metadataErrors, ...tagErrors, ...tarballErrors];

  if (errors.length > 0) {
    for (const error of errors) {
      console.error(`openclaw-npm-release-check: ${error}`);
    }
    return 1;
  }

  const parsedVersion = parseReleaseVersion(pkg.version ?? "");
  const channel = parsedVersion?.channel ?? "unknown";
  const dayDistance =
    parsedVersion === null ? "unknown" : String(utcCalendarDayDistance(parsedVersion.date, now));
  console.log(
    `openclaw-npm-release-check: validated ${channel} release ${pkg.version} (${dayDistance} day UTC delta).`,
  );
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exit(main());
}
