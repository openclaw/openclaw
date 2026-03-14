#!/usr/bin/env -S node --import tsx

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
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
  channel: "stable" | "beta";
  year: number;
  month: number;
  day: number;
  betaNumber?: number;
  date: Date;
};

const STABLE_VERSION_REGEX = /^(?<year>\d{4})\.(?<month>[1-9]\d?)\.(?<day>[1-9]\d?)$/;
const BETA_VERSION_REGEX =
  /^(?<year>\d{4})\.(?<month>[1-9]\d?)\.(?<day>[1-9]\d?)-beta\.(?<beta>[1-9]\d*)$/;
const EXPECTED_REPOSITORY_URL = "https://github.com/openclaw/openclaw";
const MAX_CALVER_DISTANCE_DAYS = 2;

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
  if (pkg.peerDependencies?.["node-llama-cpp"] !== "3.16.2") {
    errors.push(
      `package.json peerDependencies["node-llama-cpp"] must be "3.16.2"; found "${
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
  enforceCalverWindow?: boolean;
}): string[] {
  const errors: string[] = [];
  const releaseTag = params.releaseTag.trim();
  const packageVersion = params.packageVersion.trim();
  const now = params.now ?? new Date();
  const enforceCalverWindow = params.enforceCalverWindow ?? true;

  const parsedVersion = parseReleaseVersion(packageVersion);
  if (parsedVersion === null) {
    errors.push(
      `package.json version must match YYYY.M.D or YYYY.M.D-beta.N; found "${packageVersion || "<missing>"}".`,
    );
  }

  if (!releaseTag.startsWith("v")) {
    errors.push(`Release tag must start with "v"; found "${releaseTag || "<missing>"}".`);
  }

  const tagVersion = releaseTag.startsWith("v") ? releaseTag.slice(1) : releaseTag;
  const parsedTag = parseReleaseVersion(tagVersion);
  if (parsedTag === null) {
    errors.push(
      `Release tag must match vYYYY.M.D or vYYYY.M.D-beta.N; found "${releaseTag || "<missing>"}".`,
    );
  }

  const expectedTag = packageVersion ? `v${packageVersion}` : "";
  if (releaseTag !== expectedTag) {
    errors.push(
      `Release tag ${releaseTag || "<missing>"} does not match package.json version ${
        packageVersion || "<missing>"
      }; expected ${expectedTag || "<missing>"}.`,
    );
  }

  if (parsedVersion !== null && enforceCalverWindow) {
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

function main(): number {
  const pkg = loadPackageJson();
  const skipCalverWindow = process.env.RELEASE_SKIP_CALVER_WINDOW === "1";
  const now = new Date();
  const metadataErrors = collectReleasePackageMetadataErrors(pkg);
  const tagErrors = collectReleaseTagErrors({
    packageVersion: pkg.version ?? "",
    releaseTag: process.env.RELEASE_TAG ?? "",
    releaseSha: process.env.RELEASE_SHA,
    releaseMainRef: process.env.RELEASE_MAIN_REF,
    now,
    enforceCalverWindow: !skipCalverWindow,
  });
  const errors = [...metadataErrors, ...tagErrors];

  if (errors.length > 0) {
    for (const error of errors) {
      console.error(`openclaw-npm-release-check: ${error}`);
    }
    return 1;
  }

  const parsedVersion = parseReleaseVersion(pkg.version ?? "");
  const channel = parsedVersion?.channel ?? "unknown";
  const dayDistance =
    parsedVersion === null
      ? "unknown"
      : skipCalverWindow
        ? "skipped"
        : String(utcCalendarDayDistance(parsedVersion.date, now));
  console.log(
    `openclaw-npm-release-check: validated ${channel} release ${pkg.version} (${dayDistance} day UTC delta).`,
  );
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exit(main());
}
