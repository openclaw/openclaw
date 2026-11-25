import { readFileSync } from "node:fs";
import path from "node:path";
import { parseReleaseVersion } from "./release-version.mjs";

export function normalizeGatewayVersionToPinnedMobileVersion(rawVersion: string): string {
  const trimmed = rawVersion.trim().replace(/^v/u, "");
  if (!trimmed) {
    throw new Error("Missing root package.json version.");
  }

  const parsed = parseReleaseVersion(trimmed);
  if (!parsed) {
    throw new Error(
      `Invalid gateway version '${rawVersion}'. Expected YYYY.M.PATCH, YYYY.M.PATCH-alpha.N, YYYY.M.PATCH-beta.N, or YYYY.M.PATCH-N.`,
    );
  }
  return parsed.baseVersion;
}

export function readRootPackageVersion(rootDir: string): string {
  const packageJsonPath = path.join(rootDir, "package.json");
  const parsed = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { version?: unknown };
  const version = typeof parsed.version === "string" ? parsed.version.trim() : "";
  if (!version) {
    throw new Error(`Missing package.json version in ${packageJsonPath}.`);
  }
  return version;
}
