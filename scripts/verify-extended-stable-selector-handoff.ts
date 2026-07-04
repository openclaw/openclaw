#!/usr/bin/env -S node --import tsx

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { assertExtendedStableReleaseVersion } from "./lib/extended-stable-plugin-acceptance.js";
import { loadExtendedStablePluginSupport } from "./lib/extended-stable-plugin-support.js";

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function keys(value: Record<string, unknown>, expected: string[], label: string): void {
  if (JSON.stringify(Object.keys(value).toSorted()) !== JSON.stringify(expected.toSorted())) {
    throw new Error(`${label} has unexpected or missing fields.`);
  }
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value || value !== value.trim()) {
    throw new Error(`${label} must be a non-empty trimmed string.`);
  }
  return value;
}

function sha256(value: unknown, label: string): string {
  const parsed = text(value, label);
  if (!/^[0-9a-f]{64}$/u.test(parsed)) {
    throw new Error(`${label} must be a lowercase SHA-256 digest.`);
  }
  return parsed;
}

function artifactDigest(value: unknown, label: string): string {
  const parsed = text(value, label);
  if (!/^sha256:[0-9a-f]{64}$/u.test(parsed)) {
    throw new Error(`${label} must be an Actions sha256:<lowercase hex> digest.`);
  }
  return parsed;
}

function positiveInteger(value: unknown, label: string): number {
  const parsed = typeof value === "number" ? value : Number(text(value, label));
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return parsed;
}

export function verifySelectorHandoff(value: unknown, rootDir = resolve(".")): void {
  const handoff = record(value, "selector handoff");
  keys(
    handoff,
    [
      "schemaVersion",
      "handoffId",
      "releaseVersion",
      "sourceSha",
      "core",
      "pluginPublication",
      "acceptances",
      "selectorsBefore",
      "selectorsAfter",
      "selectorOrder",
      "conclusion",
    ],
    "selector handoff",
  );
  if (handoff.schemaVersion !== 1) {
    throw new Error("selector handoff schemaVersion must be 1.");
  }
  text(handoff.handoffId, "selector handoff.handoffId");
  const releaseVersion = assertExtendedStableReleaseVersion(
    text(handoff.releaseVersion, "selector handoff.releaseVersion"),
  );
  const sourceSha = text(handoff.sourceSha, "selector handoff.sourceSha");
  if (!/^[0-9a-f]{40}$/u.test(sourceSha)) {
    throw new Error("selector handoff.sourceSha must be a full lowercase Git SHA.");
  }
  if (
    handoff.conclusion !== "ready_for_protected_selector_promotion" ||
    JSON.stringify(handoff.selectorOrder) !== JSON.stringify(["plugins", "core"])
  ) {
    throw new Error("selector handoff must be ready with plugin-first/core-last order.");
  }

  const core = record(handoff.core, "selector handoff.core");
  keys(
    core,
    [
      "publicationRunId",
      "publicationRunAttempt",
      "publicationArtifactDigest",
      "version",
      "npmIntegrity",
      "candidateTag",
    ],
    "selector handoff.core",
  );
  if (core.version !== releaseVersion) {
    throw new Error("selector handoff core version must match the release version.");
  }
  positiveInteger(core.publicationRunId, "selector handoff.core.publicationRunId");
  positiveInteger(core.publicationRunAttempt, "selector handoff.core.publicationRunAttempt");
  artifactDigest(core.publicationArtifactDigest, "selector handoff.core.publicationArtifactDigest");
  const coreIntegrity = text(core.npmIntegrity, "selector handoff.core.npmIntegrity");
  if (!coreIntegrity.startsWith("sha512-")) {
    throw new Error("selector handoff core npmIntegrity must be sha512.");
  }
  const [year, month, patch] = releaseVersion.split(".");
  if (core.candidateTag !== `extended-stable-candidate-${year}-${month}-${patch}`) {
    throw new Error("selector handoff core candidate tag is invalid.");
  }

  const support = loadExtendedStablePluginSupport(rootDir);
  const expectedPackages = support.plugins.map((plugin) => plugin.packageName);
  const publication = record(handoff.pluginPublication, "selector handoff.pluginPublication");
  keys(
    publication,
    [
      "sourceSha",
      "publicationRunId",
      "publicationRunAttempt",
      "publicationArtifactDigest",
      "publicationResultSha256",
      "plugins",
    ],
    "selector handoff.pluginPublication",
  );
  if (publication.sourceSha !== sourceSha || !Array.isArray(publication.plugins)) {
    throw new Error("selector handoff plugin publication identity is invalid.");
  }
  positiveInteger(publication.publicationRunId, "plugin publication run id");
  positiveInteger(publication.publicationRunAttempt, "plugin publication run attempt");
  artifactDigest(publication.publicationArtifactDigest, "plugin publication artifact digest");
  sha256(publication.publicationResultSha256, "plugin publication result SHA-256");
  const publicationIntegrityByPackage = new Map<string, string>();
  const publishedPackages = publication.plugins.map((entry, index) => {
    const plugin = record(entry, `plugin publication plugins[${index}]`);
    keys(
      plugin,
      ["packageName", "version", "npmIntegrity", "candidateTag"],
      `plugin publication plugins[${index}]`,
    );
    if (plugin.version !== releaseVersion) {
      throw new Error(`plugin publication plugins[${index}] has a mismatched version.`);
    }
    const packageName = text(
      plugin.packageName,
      `plugin publication plugins[${index}].packageName`,
    );
    const supportEntry = support.plugins.find((candidate) => candidate.packageName === packageName);
    if (!supportEntry) {
      throw new Error(`plugin publication plugins[${index}] is not covered.`);
    }
    const integrity = text(
      plugin.npmIntegrity,
      `plugin publication plugins[${index}].npmIntegrity`,
    );
    if (!integrity.startsWith("sha512-")) {
      throw new Error(`plugin publication plugins[${index}] npmIntegrity must be sha512.`);
    }
    if (
      plugin.candidateTag !==
      `extended-stable-plugin-candidate-${supportEntry.pluginId}-${year}-${month}-${patch}`
    ) {
      throw new Error(`plugin publication plugins[${index}] candidate tag is invalid.`);
    }
    publicationIntegrityByPackage.set(packageName, integrity);
    return packageName;
  });
  if (JSON.stringify(publishedPackages) !== JSON.stringify(expectedPackages)) {
    throw new Error("selector handoff publication must contain exactly the covered packages.");
  }

  if (!Array.isArray(handoff.acceptances)) {
    throw new Error("selector handoff.acceptances must be an array.");
  }
  const acceptedPackages = handoff.acceptances.map((entry, index) => {
    const acceptance = record(entry, `selector handoff.acceptances[${index}]`);
    keys(
      acceptance,
      [
        "packageName",
        "npmIntegrity",
        "workflowSha",
        "acceptanceRunId",
        "acceptanceRunAttempt",
        "acceptanceArtifactDigest",
        "acceptanceResultSha256",
      ],
      `selector handoff.acceptances[${index}]`,
    );
    sha256(acceptance.acceptanceResultSha256, `acceptances[${index}] result SHA-256`);
    artifactDigest(acceptance.acceptanceArtifactDigest, `acceptances[${index}] artifact digest`);
    positiveInteger(acceptance.acceptanceRunId, `acceptances[${index}] run id`);
    positiveInteger(acceptance.acceptanceRunAttempt, `acceptances[${index}] run attempt`);
    const workflowSha = text(acceptance.workflowSha, `acceptances[${index}] workflow SHA`);
    if (!/^[0-9a-f]{40}$/u.test(workflowSha)) {
      throw new Error(`acceptances[${index}] workflow SHA must be full lowercase hex.`);
    }
    const packageName = text(acceptance.packageName, `acceptances[${index}].packageName`);
    if (acceptance.npmIntegrity !== publicationIntegrityByPackage.get(packageName)) {
      throw new Error(`acceptances[${index}] integrity does not match publication.`);
    }
    return packageName;
  });
  if (JSON.stringify(acceptedPackages) !== JSON.stringify(expectedPackages)) {
    throw new Error("selector handoff acceptances must contain exactly the covered packages.");
  }

  for (const field of ["selectorsBefore", "selectorsAfter"] as const) {
    const values = record(handoff[field], `selector handoff.${field}`);
    const expectedSelectorKeys = ["openclaw", ...expectedPackages].toSorted();
    if (JSON.stringify(Object.keys(values).toSorted()) !== JSON.stringify(expectedSelectorKeys)) {
      throw new Error(`selector handoff.${field} must contain only core and covered plugins.`);
    }
    for (const [packageName, packageValue] of Object.entries(values)) {
      const selectors = record(packageValue, `selector handoff.${field}.${packageName}`);
      keys(selectors, ["latest", "extendedStable"], `selector handoff.${field}.${packageName}`);
      for (const selectorValue of Object.values(selectors)) {
        if (selectorValue !== null && (typeof selectorValue !== "string" || !selectorValue)) {
          throw new Error(`selector handoff.${field}.${packageName} is invalid.`);
        }
      }
    }
  }
  if (JSON.stringify(handoff.selectorsBefore) !== JSON.stringify(handoff.selectorsAfter)) {
    throw new Error("selector handoff shared selectors changed during candidate publication.");
  }
}

function isMain(): boolean {
  return (
    process.argv[1] !== undefined &&
    import.meta.url === pathToFileURL(resolve(process.argv[1])).href
  );
}

if (isMain()) {
  const path = process.argv[2];
  if (!path || process.argv.length !== 3) {
    throw new Error("Usage: verify-extended-stable-selector-handoff.ts <handoff.json>");
  }
  verifySelectorHandoff(JSON.parse(readFileSync(path, "utf8")));
  console.log("Extended-stable selector handoff verified.");
}
