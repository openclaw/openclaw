// Android Version script supports OpenClaw repository automation.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const ANDROID_VERSION_FILE = "apps/android/version.json";
const ANDROID_VERSION_PROPERTIES_FILE = "apps/android/Config/Version.properties";

const PINNED_ANDROID_VERSION_PATTERN = /^(\d{4}\.\d{1,2}\.[1-9]\d*)$/u;
const GATEWAY_VERSION_PATTERN = /^(\d{4}\.\d{1,2}\.[1-9]\d*)(?:-(?:alpha\.\d+|beta\.\d+|\d+))?$/u;

type AndroidVersionManifest = {
  version: string;
  versionCode: number;
};

export type ResolvedAndroidVersion = {
  canonicalVersion: string;
  versionCode: number;
  versionFilePath: string;
  versionPropertiesPath: string;
};

type SyncAndroidVersioningMode = "check" | "write";

function normalizeTrailingNewline(value: string): string {
  return value.endsWith("\n") ? value : `${value}\n`;
}

export function normalizePinnedAndroidVersion(rawVersion: string): string {
  const trimmed = rawVersion.trim();
  if (!trimmed) {
    throw new Error(`Missing Android version in ${ANDROID_VERSION_FILE}.`);
  }

  const match = PINNED_ANDROID_VERSION_PATTERN.exec(trimmed);
  if (!match) {
    throw new Error(
      `Invalid Android version '${rawVersion}'. Expected pinned release version like 2026.6.5.`,
    );
  }

  return match[1] ?? trimmed;
}

export function normalizeGatewayVersionToPinnedAndroidVersion(rawVersion: string): string {
  const trimmed = rawVersion.trim().replace(/^v/u, "");
  if (!trimmed) {
    throw new Error("Missing root package.json version.");
  }

  const match = GATEWAY_VERSION_PATTERN.exec(trimmed);
  if (!match) {
    throw new Error(
      `Invalid gateway version '${rawVersion}'. Expected YYYY.M.PATCH, YYYY.M.PATCH-alpha.N, YYYY.M.PATCH-beta.N, or YYYY.M.PATCH-N.`,
    );
  }

  return match[1] ?? trimmed;
}

export function canonicalAndroidVersionCode(version: string): number {
  const canonicalVersion = normalizePinnedAndroidVersion(version);
  const [year, rawMonth, rawPatch] = canonicalVersion.split(".");
  const month = rawMonth?.padStart(2, "0");
  const patch = rawPatch?.padStart(2, "0");
  const versionCode = Number.parseInt(`${year}${month}${patch}01`, 10);
  if (!Number.isInteger(versionCode)) {
    throw new Error(`Unable to derive Android versionCode from ${canonicalVersion}.`);
  }
  return versionCode;
}

export function normalizeAndroidVersionCode(rawVersionCode: number, version: string): number {
  if (!Number.isInteger(rawVersionCode) || rawVersionCode <= 0 || rawVersionCode > 2_100_000_000) {
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
    suffix > 99
  ) {
    throw new Error(
      `Invalid Android versionCode '${rawVersionCode}'. Expected ${prefix}01 through ${prefix}99 for version ${version}.`,
    );
  }

  return rawVersionCode;
}

function readRootPackageVersion(rootDir = path.resolve(".")): string {
  const packageJsonPath = path.join(rootDir, "package.json");
  const parsed = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { version?: unknown };
  const version = typeof parsed.version === "string" ? parsed.version.trim() : "";
  if (!version) {
    throw new Error(`Missing package.json version in ${packageJsonPath}.`);
  }
  return version;
}

export function resolveGatewayVersionForAndroidRelease(rootDir = path.resolve(".")): {
  packageVersion: string;
  pinnedAndroidVersion: string;
  versionCode: number;
} {
  const packageVersion = readRootPackageVersion(rootDir);
  const pinnedAndroidVersion = normalizeGatewayVersionToPinnedAndroidVersion(packageVersion);
  return {
    packageVersion,
    pinnedAndroidVersion,
    versionCode: canonicalAndroidVersionCode(pinnedAndroidVersion),
  };
}

function readAndroidVersionManifest(rootDir = path.resolve(".")): AndroidVersionManifest {
  const versionFilePath = path.join(rootDir, ANDROID_VERSION_FILE);
  return JSON.parse(readFileSync(versionFilePath, "utf8")) as AndroidVersionManifest;
}

export function writeAndroidVersionManifest(
  version: string,
  versionCode: number | null,
  rootDir = path.resolve("."),
): string {
  const versionFilePath = path.join(rootDir, ANDROID_VERSION_FILE);
  const normalizedVersion = normalizePinnedAndroidVersion(version);
  const normalizedVersionCode = normalizeAndroidVersionCode(
    versionCode ?? canonicalAndroidVersionCode(normalizedVersion),
    normalizedVersion,
  );
  const nextContent = `${JSON.stringify(
    { version: normalizedVersion, versionCode: normalizedVersionCode },
    null,
    2,
  )}\n`;
  writeFileSync(versionFilePath, nextContent, "utf8");
  return versionFilePath;
}

export function resolveAndroidVersion(rootDir = path.resolve(".")): ResolvedAndroidVersion {
  const versionFilePath = path.join(rootDir, ANDROID_VERSION_FILE);
  const versionPropertiesPath = path.join(rootDir, ANDROID_VERSION_PROPERTIES_FILE);
  const manifest = readAndroidVersionManifest(rootDir);
  const canonicalVersion = normalizePinnedAndroidVersion(manifest.version ?? "");
  const versionCode = normalizeAndroidVersionCode(manifest.versionCode, canonicalVersion);

  return {
    canonicalVersion,
    versionCode,
    versionFilePath,
    versionPropertiesPath,
  };
}

export function renderAndroidVersionProperties(version: ResolvedAndroidVersion): string {
  return `# Shared Android version defaults.\n# Source of truth: apps/android/version.json\n# Generated by scripts/android-sync-versioning.ts.\n\nOPENCLAW_ANDROID_VERSION_NAME=${version.canonicalVersion}\nOPENCLAW_ANDROID_VERSION_CODE=${version.versionCode}\n`;
}

function syncFile(params: {
  mode: SyncAndroidVersioningMode;
  path: string;
  nextContent: string;
  label: string;
}): boolean {
  const nextContent = normalizeTrailingNewline(params.nextContent);
  const currentContent = readFileSync(params.path, "utf8");
  if (currentContent === nextContent) {
    return false;
  }

  if (params.mode === "check") {
    throw new Error(`${params.label} is stale: ${path.relative(process.cwd(), params.path)}`);
  }

  writeFileSync(params.path, nextContent, "utf8");
  return true;
}

export function syncAndroidVersioning(params?: {
  mode?: SyncAndroidVersioningMode;
  rootDir?: string;
}): {
  updatedPaths: string[];
} {
  const mode = params?.mode ?? "write";
  const rootDir = path.resolve(params?.rootDir ?? ".");
  const version = resolveAndroidVersion(rootDir);
  const nextVersionProperties = renderAndroidVersionProperties(version);
  const updatedPaths: string[] = [];

  if (
    syncFile({
      mode,
      path: version.versionPropertiesPath,
      nextContent: nextVersionProperties,
      label: "Android version properties",
    })
  ) {
    updatedPaths.push(version.versionPropertiesPath);
  }

  return { updatedPaths };
}
