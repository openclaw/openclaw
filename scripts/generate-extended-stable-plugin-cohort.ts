#!/usr/bin/env -S node --import tsx

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  EXTENDED_STABLE_PLUGIN_COHORT_PATH,
  loadExtendedStablePluginCohort,
  parseExtendedStablePluginCohort,
  type ExtendedStablePluginCohort,
} from "../src/plugins/extended-stable-plugin-cohort.js";
import { resolveExtendedStableCohortPackageNames } from "../src/plugins/extended-stable-plugin-target.js";
import { loadExtendedStablePluginSupport } from "./lib/extended-stable-plugin-support.js";
import { collectPublishablePluginPackages } from "./lib/plugin-npm-release.js";
import { parseReleaseVersion } from "./openclaw-npm-release-check.js";

type CohortEvidencePackage = {
  packageName: string;
  version: string;
  npmIntegrity: string;
};

export type EligibleCohortEvidence = {
  releaseVersion: string;
  releaseTag: string;
  openclawNpmIntegrity: string;
  pluginNpmPackages: CohortEvidencePackage[];
};

type GenerateResult =
  | { action: "not-required" }
  | { action: "written" | "verified"; baselineVersion: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function parseEvidencePackage(
  value: unknown,
  releaseVersion: string,
): CohortEvidencePackage | null {
  if (!isRecord(value)) {
    return null;
  }
  const { packageName, version, npmIntegrity } = value;
  if (
    typeof packageName !== "string" ||
    !packageName ||
    version !== releaseVersion ||
    typeof npmIntegrity !== "string" ||
    !npmIntegrity.startsWith("sha512-")
  ) {
    return null;
  }
  return { packageName, version, npmIntegrity };
}

export function parseEligibleCohortEvidence(params: {
  value: unknown;
  releaseLine: string;
  expectedPackageNames: readonly string[];
}): EligibleCohortEvidence | null {
  if (!isRecord(params.value)) {
    return null;
  }
  const releaseVersion =
    typeof params.value.releaseVersion === "string" ? params.value.releaseVersion : "";
  const parsed = parseReleaseVersion(releaseVersion);
  if (
    params.value.version !== 1 ||
    parsed?.channel !== "stable" ||
    parsed.correctionNumber !== undefined ||
    `${parsed.year}.${parsed.month}` !== params.releaseLine ||
    parsed.patch >= 33 ||
    params.value.releaseTag !== `v${releaseVersion}` ||
    params.value.npmDistTag !== "latest" ||
    params.value.pluginPublishScope !== "all-publishable" ||
    typeof params.value.openclawNpmIntegrity !== "string" ||
    !params.value.openclawNpmIntegrity.startsWith("sha512-") ||
    !Array.isArray(params.value.pluginNpmPackages)
  ) {
    return null;
  }

  const packages = params.value.pluginNpmPackages.map((value) =>
    parseEvidencePackage(value, releaseVersion),
  );
  if (packages.some((value) => value === null)) {
    return null;
  }
  const pluginNpmPackages = packages as CohortEvidencePackage[];
  const packageNames = pluginNpmPackages.map((entry) => entry.packageName);
  if (
    new Set(packageNames).size !== packageNames.length ||
    !sameStrings(packageNames, packageNames.toSorted()) ||
    !sameStrings(packageNames, [...params.expectedPackageNames].toSorted())
  ) {
    return null;
  }
  return {
    releaseVersion,
    releaseTag: `v${releaseVersion}`,
    openclawNpmIntegrity: params.value.openclawNpmIntegrity,
    pluginNpmPackages,
  };
}

function collectExtendedStablePluginInventory(rootDir: string): {
  cohortPackageNames: string[];
  allPublishablePackageNames: string[];
} {
  const support = loadExtendedStablePluginSupport(rootDir);
  const cohortPackageNames = [...resolveExtendedStableCohortPackageNames({ support })].toSorted();
  const allCatalogPackageNames = [
    ...cohortPackageNames,
    ...support.plugins.map((plugin) => plugin.packageName),
  ].toSorted();
  const publishablePackageNames = collectPublishablePluginPackages(rootDir).map(
    (plugin) => plugin.packageName,
  );
  if (!sameStrings(allCatalogPackageNames, publishablePackageNames)) {
    throw new Error(
      "Official npm catalog package set must exactly match the all-publishable plugin release plan.",
    );
  }
  return { cohortPackageNames, allPublishablePackageNames: publishablePackageNames };
}

export function collectExtendedStableCohortPackageNames(rootDir = resolve(".")): string[] {
  return collectExtendedStablePluginInventory(rootDir).cohortPackageNames;
}

export function collectAllPublishablePluginPackageNames(rootDir = resolve(".")): string[] {
  return collectExtendedStablePluginInventory(rootDir).allPublishablePackageNames;
}

export function selectExtendedStablePluginCohort(params: {
  releaseVersion: string;
  expectedPackageNames: readonly string[];
  evidence: readonly unknown[];
}): ExtendedStablePluginCohort {
  const release = parseReleaseVersion(params.releaseVersion);
  if (release?.channel !== "stable" || release.correctionNumber !== undefined) {
    throw new Error("Cohort generation requires a final YYYY.M.PATCH release version.");
  }
  const releaseLine = `${release.year}.${release.month}`;
  const eligible = params.evidence
    .map((value) =>
      parseEligibleCohortEvidence({
        value,
        releaseLine,
        expectedPackageNames: params.expectedPackageNames,
      }),
    )
    .filter((value): value is EligibleCohortEvidence => value !== null)
    .toSorted((left, right) => {
      const leftPatch = parseReleaseVersion(left.releaseVersion)?.patch ?? 0;
      const rightPatch = parseReleaseVersion(right.releaseVersion)?.patch ?? 0;
      return rightPatch - leftPatch;
    });
  const selected = eligible[0];
  if (!selected) {
    throw new Error(
      `No eligible ${releaseLine} full regular release evidence was found for the monthly cohort.`,
    );
  }
  return { schemaVersion: 1, releaseLine, baselineVersion: selected.releaseVersion };
}

function readEvidenceDirectory(evidenceDir: string): unknown[] {
  return readdirSync(evidenceDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => JSON.parse(readFileSync(join(evidenceDir, entry.name), "utf8")) as unknown);
}

export function generateExtendedStablePluginCohort(params: {
  rootDir: string;
  evidenceDir?: string;
  expectedPackageNames?: readonly string[];
  fix: boolean;
}): GenerateResult {
  const packageJson = JSON.parse(readFileSync(join(params.rootDir, "package.json"), "utf8")) as {
    version?: unknown;
  };
  const releaseVersion = typeof packageJson.version === "string" ? packageJson.version : "";
  const release = parseReleaseVersion(releaseVersion);
  if (!release) {
    throw new Error("Root package version must be a valid OpenClaw release.");
  }
  if (release.channel !== "stable" || release.correctionNumber !== undefined) {
    return { action: "not-required" };
  }
  if (release.patch < 33) {
    return { action: "not-required" };
  }
  if (!params.evidenceDir) {
    throw new Error("Patch 33 and later release prep requires --cohort-evidence-dir.");
  }
  const expectedPackageNames =
    params.expectedPackageNames ?? collectAllPublishablePluginPackageNames(params.rootDir);
  const cohort = selectExtendedStablePluginCohort({
    releaseVersion,
    expectedPackageNames,
    evidence: readEvidenceDirectory(params.evidenceDir),
  });
  const cohortPath = join(params.rootDir, EXTENDED_STABLE_PLUGIN_COHORT_PATH);
  if (release.patch === 33 && params.fix) {
    const existing = existsSync(cohortPath)
      ? loadExtendedStablePluginCohort(params.rootDir)
      : undefined;
    if (!existing || existing.releaseLine !== cohort.releaseLine) {
      writeFileSync(cohortPath, `${JSON.stringify(cohort, null, 2)}\n`);
      return { action: "written", baselineVersion: cohort.baselineVersion };
    }
  }
  if (!existsSync(cohortPath)) {
    throw new Error(
      release.patch === 33
        ? "The first patch 33 activation requires --fix to generate cohort metadata."
        : "Extended-stable maintenance releases require existing cohort metadata.",
    );
  }
  const existing = loadExtendedStablePluginCohort(params.rootDir);
  if (JSON.stringify(existing) !== JSON.stringify(parseExtendedStablePluginCohort(cohort))) {
    throw new Error("Extended-stable monthly cohort metadata is immutable within a release line.");
  }
  return { action: "verified", baselineVersion: cohort.baselineVersion };
}

function parseArgs(argv: string[]): { fix: boolean; evidenceDir?: string } {
  let fix = false;
  let evidenceDir: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--fix") {
      fix = true;
    } else if (arg === "--check") {
      fix = false;
    } else if (arg === "--cohort-evidence-dir") {
      evidenceDir = argv[++index];
      if (!evidenceDir) {
        throw new Error("--cohort-evidence-dir requires a value.");
      }
    } else {
      throw new Error(`Unknown cohort generator argument: ${arg}`);
    }
  }
  return { fix, evidenceDir };
}

function isMain(): boolean {
  return (
    process.argv[1] !== undefined &&
    import.meta.url === pathToFileURL(resolve(process.argv[1])).href
  );
}

if (isMain()) {
  const args = parseArgs(process.argv.slice(2));
  const result = generateExtendedStablePluginCohort({
    rootDir: resolve("."),
    evidenceDir: args.evidenceDir ? resolve(args.evidenceDir) : undefined,
    fix: args.fix,
  });
  console.log(`extended-stable-plugin-cohort: ${result.action}`);
}
