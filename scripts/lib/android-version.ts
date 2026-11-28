import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { validateAndroidStorePlan } from "./android-store-version.ts";
import { readRootPackageVersion } from "./mobile-version.ts";
import { parsePinnedReleaseVersion, parseReleaseVersion } from "./release-version.mjs";

const ANDROID_VERSION_CODE_MAX = 2_100_000_000;

type ResolvedAndroidVersion = ReturnType<typeof resolveAndroidVersion>;

function normalizeAndroidVersion(rawVersion: string): string {
  const trimmed = rawVersion.trim();
  if (!trimmed) {
    throw new Error("Missing Android version.");
  }

  const version = parsePinnedReleaseVersion(trimmed);
  if (!version) {
    throw new Error(
      `Invalid Android version '${rawVersion}'. Expected a release version like 2026.6.5.`,
    );
  }

  return version;
}

function canonicalAndroidVersionCode(version: string): number {
  const canonicalVersion = normalizeAndroidVersion(version);
  const [year, rawMonth, rawPatch] = canonicalVersion.split(".");
  const month = rawMonth?.padStart(2, "0");
  const patch = rawPatch?.padStart(2, "0");
  const versionCode = Number(`${year}${month}${patch}01`);
  if (
    !Number.isSafeInteger(versionCode) ||
    versionCode <= 0 ||
    versionCode > ANDROID_VERSION_CODE_MAX
  ) {
    throw new Error(`Unable to derive Android versionCode from ${canonicalVersion}.`);
  }
  return versionCode;
}

function normalizeAndroidVersionCode(rawVersionCode: number, version: string): number {
  if (
    !Number.isInteger(rawVersionCode) ||
    rawVersionCode <= 0 ||
    rawVersionCode > ANDROID_VERSION_CODE_MAX
  ) {
    throw new Error(
      `Invalid Android versionCode '${rawVersionCode}'. Expected a positive integer no greater than 2100000000.`,
    );
  }

  const prefix = canonicalAndroidVersionCode(version).toString().slice(0, -2);
  const raw = rawVersionCode.toString();
  const suffix = Number.parseInt(raw.slice(prefix.length), 10);
  if (
    !raw.startsWith(prefix) ||
    raw.length !== prefix.length + 2 ||
    !Number.isInteger(suffix) ||
    suffix < 1 ||
    suffix > 49
  ) {
    throw new Error(
      `Invalid Android versionCode '${rawVersionCode}'. Expected ${prefix}01 through ${prefix}49 for version ${version}.`,
    );
  }

  return rawVersionCode;
}

export function resolveAndroidVersion(rootDir = path.resolve(".")) {
  const packageVersion = readRootPackageVersion(rootDir);
  const parsed = parseReleaseVersion(packageVersion.trim().replace(/^v/u, ""));
  if (!parsed) {
    throw new Error(`Invalid Gateway version ${packageVersion}.`);
  }
  const canonicalVersion = parsed.baseVersion;
  const buildNumber = (parsed.correctionNumber ?? 0) + 1;
  if (buildNumber > 49) {
    throw new Error("Android local correction build number must be 01 through 49.");
  }
  const versionCode = canonicalAndroidVersionCode(canonicalVersion) + buildNumber - 1;
  return { canonicalVersion, versionCode, wearVersionCode: versionCode + 50 };
}

export function resolveAndroidBuildVersion(
  rootDir = path.resolve("."),
  planPath = process.env.OPENCLAW_ANDROID_RELEASE_PLAN,
): ResolvedAndroidVersion {
  if (!planPath) {
    return resolveAndroidVersion(rootDir);
  }
  const plan = JSON.parse(readFileSync(planPath, "utf8")) as {
    schemaVersion?: number;
    version: string;
    versionCode: number;
    wearVersionCode: number;
    sourceSha: string;
  };
  let canonicalVersion: string;
  let versionCode: number;
  if (plan.schemaVersion === 2) {
    const storePlan = validateAndroidStorePlan(plan);
    canonicalVersion = storePlan.version;
    versionCode = storePlan.versionCode;
  } else if (plan.schemaVersion === undefined) {
    // Retained pre-cutover plans must still reproduce their original artifacts.
    canonicalVersion = normalizeAndroidVersion(plan.version);
    versionCode = normalizeAndroidVersionCode(plan.versionCode, canonicalVersion);
    if (plan.wearVersionCode !== versionCode + 50) {
      throw new Error("Android release plan Wear versionCode must equal the phone code plus 50.");
    }
  } else {
    throw new Error(`Unsupported Android release plan schema ${plan.schemaVersion}.`);
  }
  const head = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: rootDir,
    encoding: "utf8",
  }).trim();
  if (!/^[a-f0-9]{40}$/u.test(plan.sourceSha) || plan.sourceSha !== head) {
    throw new Error("Android release plan sourceSha must match the checked-out commit.");
  }
  return { canonicalVersion, versionCode, wearVersionCode: plan.wearVersionCode };
}
