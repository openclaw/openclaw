#!/usr/bin/env -S node --import tsx
// Plugin Npm Publication Result script closes extended-stable matrix evidence.

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  collectExtendedStablePublishablePluginPackages,
  collectExtendedStableSnapshotPluginPackages,
  deriveExtendedStablePluginCandidateTag,
} from "./lib/plugin-npm-release.ts";

type PublicationIdentity = {
  repository: string;
  workflowPath: string;
  workflowRef: string;
  workflowSha: string;
  runId: string;
  runAttempt: string;
};

export type ExtendedStablePluginPublicationRecord = PublicationIdentity & {
  packageName: string;
  version: string;
  npmIntegrity: string;
  candidateTag: string;
  provenanceVerified: true;
  sourceSha: string;
};

export type ExtendedStablePluginPublicationResult = {
  schemaVersion: 2;
  sourceSha: string;
  workflow: PublicationIdentity;
  plugins: Array<{
    packageName: string;
    version: string;
    npmIntegrity: string;
    candidateTag: string;
    provenanceVerified: true;
  }>;
  snapshotReadbacks: Array<{
    packageName: string;
    version: string;
    npmIntegrity: string;
    installVerified: true;
  }>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseClosedRecord(value: unknown, label: string): ExtendedStablePluginPublicationRecord {
  if (!isRecord(value)) {
    throw new Error(`${label} must be a JSON object.`);
  }
  const expectedKeys = [
    "candidateTag",
    "npmIntegrity",
    "packageName",
    "provenanceVerified",
    "repository",
    "runAttempt",
    "runId",
    "sourceSha",
    "version",
    "workflowPath",
    "workflowRef",
    "workflowSha",
  ];
  if (JSON.stringify(Object.keys(value).toSorted()) !== JSON.stringify(expectedKeys)) {
    throw new Error(`${label} has an unexpected field set.`);
  }
  for (const field of expectedKeys.filter((candidate) => candidate !== "provenanceVerified")) {
    if (typeof value[field] !== "string" || !value[field].trim()) {
      throw new Error(`${label}.${field} must be a non-empty string.`);
    }
  }
  if (value.provenanceVerified !== true) {
    throw new Error(`${label}.provenanceVerified must be true.`);
  }
  return value as ExtendedStablePluginPublicationRecord;
}

export function buildExtendedStablePluginPublicationResult(params: {
  rootDir?: string;
  records: unknown[];
  snapshotReadbacks: unknown[];
  sourceSha: string;
  identity: PublicationIdentity;
}): ExtendedStablePluginPublicationResult {
  const rootDir = params.rootDir ?? resolve(".");
  if (!/^[0-9a-f]{40}$/u.test(params.sourceSha)) {
    throw new Error("sourceSha must be a full lowercase commit SHA.");
  }
  if (params.identity.repository !== "openclaw/openclaw") {
    throw new Error("Publication repository must be openclaw/openclaw.");
  }
  if (params.identity.workflowPath !== ".github/workflows/plugin-npm-release.yml") {
    throw new Error("Publication workflowPath must identify plugin-npm-release.yml.");
  }
  if (!/^[0-9a-f]{40}$/u.test(params.identity.workflowSha)) {
    throw new Error("workflowSha must be a full lowercase commit SHA.");
  }
  if (params.identity.workflowSha !== params.sourceSha) {
    throw new Error("workflowSha must equal the protected source SHA.");
  }
  if (!/^\d+$/u.test(params.identity.runId) || !/^\d+$/u.test(params.identity.runAttempt)) {
    throw new Error("Publication runId and runAttempt must be decimal strings.");
  }
  const rootPackage = JSON.parse(readFileSync(join(rootDir, "package.json"), "utf8")) as {
    version?: unknown;
  };
  if (typeof rootPackage.version !== "string" || !rootPackage.version.trim()) {
    throw new Error("Root package.json version must be a non-empty string.");
  }
  const version = rootPackage.version.trim();
  const selectedPackages = collectExtendedStablePublishablePluginPackages(rootDir);
  const records = params.records
    .map((record, index) => parseClosedRecord(record, `publication record ${index}`))
    .toSorted((left, right) => left.packageName.localeCompare(right.packageName));

  const expectedNames = selectedPackages.map((entry) => entry.packageName);
  if (
    JSON.stringify(records.map((record) => record.packageName)) !== JSON.stringify(expectedNames)
  ) {
    throw new Error(`Publication records must contain exactly: ${expectedNames.join(", ")}.`);
  }
  const selectedByName = new Map(selectedPackages.map((entry) => [entry.packageName, entry]));
  for (const record of records) {
    const entry = selectedByName.get(record.packageName);
    if (!entry) {
      throw new Error(`Unexpected publication package: ${record.packageName}.`);
    }
    if (record.version !== version) {
      throw new Error(
        `${record.packageName} publication version must equal root version ${version}; found ${record.version}.`,
      );
    }
    const expectedCandidateTag = deriveExtendedStablePluginCandidateTag({
      pluginId: entry.extensionId,
      version,
    });
    if (record.candidateTag !== expectedCandidateTag) {
      throw new Error(
        `${record.packageName} candidate tag must be ${expectedCandidateTag}; found ${record.candidateTag}.`,
      );
    }
    if (!record.npmIntegrity.startsWith("sha512-")) {
      throw new Error(`${record.packageName} npm integrity must be a sha512 digest.`);
    }
    for (const key of [
      "repository",
      "workflowPath",
      "workflowRef",
      "workflowSha",
      "runId",
      "runAttempt",
    ] as const) {
      if (record[key] !== params.identity[key]) {
        throw new Error(`${record.packageName} ${key} does not match the publication run.`);
      }
    }
    if (record.sourceSha !== params.sourceSha) {
      throw new Error(`${record.packageName} sourceSha does not match the protected source SHA.`);
    }
  }

  const snapshotVersion = `${version.split(".").slice(0, 2).join(".")}.33`;
  const expectedSnapshotNames = collectExtendedStableSnapshotPluginPackages(rootDir).map(
    (plugin) => plugin.packageName,
  );
  const snapshotReadbacks = params.snapshotReadbacks
    .map((value, index) => {
      const label = `snapshot readback ${index}`;
      if (!isRecord(value)) {
        throw new Error(`${label} must be a JSON object.`);
      }
      const expectedKeys = ["installVerified", "npmIntegrity", "packageName", "version"];
      if (JSON.stringify(Object.keys(value).toSorted()) !== JSON.stringify(expectedKeys)) {
        throw new Error(`${label} has an unexpected field set.`);
      }
      const packageName = value.packageName;
      const readbackVersion = value.version;
      const npmIntegrity = value.npmIntegrity;
      if (
        typeof packageName !== "string" ||
        typeof readbackVersion !== "string" ||
        typeof npmIntegrity !== "string" ||
        !npmIntegrity.startsWith("sha512-") ||
        value.installVerified !== true
      ) {
        throw new Error(`${label} is invalid.`);
      }
      if (readbackVersion !== snapshotVersion) {
        throw new Error(`${packageName} snapshot version must be ${snapshotVersion}.`);
      }
      return {
        packageName,
        version: readbackVersion,
        npmIntegrity,
        installVerified: true as const,
      };
    })
    .toSorted((left, right) => left.packageName.localeCompare(right.packageName));
  if (
    JSON.stringify(snapshotReadbacks.map((entry) => entry.packageName)) !==
    JSON.stringify(expectedSnapshotNames)
  ) {
    throw new Error(
      `Snapshot readbacks must contain exactly: ${expectedSnapshotNames.join(", ")}.`,
    );
  }
  if (version === snapshotVersion) {
    const publicationIntegrityByPackage = new Map(
      records.map((record) => [record.packageName, record.npmIntegrity]),
    );
    for (const snapshot of snapshotReadbacks) {
      if (publicationIntegrityByPackage.get(snapshot.packageName) !== snapshot.npmIntegrity) {
        throw new Error(`${snapshot.packageName} snapshot integrity must match publication.`);
      }
    }
  }

  return {
    schemaVersion: 2,
    sourceSha: params.sourceSha,
    workflow: params.identity,
    plugins: records.map((record) => ({
      packageName: record.packageName,
      version: record.version,
      npmIntegrity: record.npmIntegrity,
      candidateTag: record.candidateTag,
      provenanceVerified: true,
    })),
    snapshotReadbacks,
  };
}

function requiredArg(argv: string[], flag: string): string {
  const index = argv.indexOf(flag);
  const value = index >= 0 ? argv[index + 1]?.trim() : "";
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} is required.`);
  }
  return value;
}

function main(argv: string[]): void {
  const resultsDir = requiredArg(argv, "--results-dir");
  const output = requiredArg(argv, "--output");
  const snapshotReadbacksPath = requiredArg(argv, "--snapshot-readbacks");
  const sourceSha = requiredArg(argv, "--source-sha");
  const identity: PublicationIdentity = {
    repository: requiredArg(argv, "--repository"),
    workflowPath: requiredArg(argv, "--workflow-path"),
    workflowRef: requiredArg(argv, "--workflow-ref"),
    workflowSha: requiredArg(argv, "--workflow-sha"),
    runId: requiredArg(argv, "--run-id"),
    runAttempt: requiredArg(argv, "--run-attempt"),
  };
  const records = readdirSync(resultsDir)
    .filter((name) => name.endsWith(".json"))
    .toSorted()
    .map((name) => JSON.parse(readFileSync(join(resultsDir, name), "utf8")) as unknown);
  const result = buildExtendedStablePluginPublicationResult({
    records,
    snapshotReadbacks: JSON.parse(readFileSync(snapshotReadbacksPath, "utf8")) as unknown[],
    sourceSha,
    identity,
  });
  writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(
      `plugin-npm-publication-result: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}
