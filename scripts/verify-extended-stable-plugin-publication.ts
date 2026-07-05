#!/usr/bin/env -S node --import tsx

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  assertExtendedStableReleaseVersion,
  sha256File,
} from "./lib/extended-stable-plugin-acceptance.js";
import {
  collectExtendedStablePublishablePluginPackages,
  collectExtendedStableSnapshotPluginPackages,
  deriveExtendedStablePluginCandidateTag,
} from "./lib/plugin-npm-release.js";

type Args = {
  result: string;
  root: string;
  releaseVersion: string;
  sourceSha: string;
  repository: string;
  workflowRef: string;
  runId: string;
  runAttempt: string;
  artifactDigest: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertKeys(value: Record<string, unknown>, keys: string[], label: string): void {
  if (JSON.stringify(Object.keys(value).toSorted()) !== JSON.stringify(keys.toSorted())) {
    throw new Error(`${label} has unexpected or missing fields.`);
  }
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string" || !value || value !== value.trim()) {
    throw new Error(`${label} must be a non-empty trimmed string.`);
  }
  return value;
}

function parseArgs(argv: string[]): Args {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined || values.has(key)) {
      throw new Error("Publication verifier requires unique --key value arguments.");
    }
    values.set(key, value);
  }
  const names = [
    "result",
    "root",
    "release-version",
    "source-sha",
    "repository",
    "workflow-ref",
    "run-id",
    "run-attempt",
    "artifact-digest",
  ];
  if (values.size !== names.length || names.some((name) => !values.has(`--${name}`))) {
    throw new Error(`Publication verifier requires exactly: ${names.join(", ")}.`);
  }
  return Object.fromEntries(
    names.map((name) => [
      name.replace(/-([a-z])/gu, (_, letter: string) => letter.toUpperCase()),
      values.get(`--${name}`)!,
    ]),
  ) as Args;
}

function npmIntegrity(spec: string): string {
  const output = execFileSync(
    "npm",
    ["view", spec, "dist.integrity", "--json", "--registry=https://registry.npmjs.org/"],
    {
      encoding: "utf8",
      timeout: 2 * 60 * 1000,
    },
  );
  const value: unknown = JSON.parse(output);
  if (typeof value !== "string") {
    throw new Error(`npm did not return an integrity for ${spec}.`);
  }
  return value;
}

function npmVersion(spec: string): string {
  const output = execFileSync(
    "npm",
    ["view", spec, "version", "--json", "--registry=https://registry.npmjs.org/"],
    {
      encoding: "utf8",
      timeout: 2 * 60 * 1000,
    },
  );
  const value: unknown = JSON.parse(output);
  if (typeof value !== "string") {
    throw new Error(`npm did not return a version for ${spec}.`);
  }
  return value;
}

export function verifyPublication(args: Args) {
  const releaseVersion = assertExtendedStableReleaseVersion(args.releaseVersion);
  if (!/^[0-9a-f]{40}$/u.test(args.sourceSha)) {
    throw new Error("source SHA must be a full lowercase Git SHA.");
  }
  if (!/^sha256:[0-9a-f]{64}$/u.test(args.artifactDigest)) {
    throw new Error("Publication artifact API digest must be sha256:<lowercase hex>.");
  }
  const raw: unknown = JSON.parse(readFileSync(args.result, "utf8"));
  if (!isRecord(raw)) {
    throw new Error("Publication result must be an object.");
  }
  assertKeys(
    raw,
    ["schemaVersion", "sourceSha", "workflow", "plugins", "snapshotReadbacks"],
    "publication result",
  );
  if (
    raw.schemaVersion !== 2 ||
    raw.sourceSha !== args.sourceSha ||
    !Array.isArray(raw.plugins) ||
    !Array.isArray(raw.snapshotReadbacks)
  ) {
    throw new Error("Publication result version, source SHA, or plugins is invalid.");
  }
  if (!isRecord(raw.workflow)) {
    throw new Error("Publication workflow must be an object.");
  }
  assertKeys(
    raw.workflow,
    ["repository", "workflowPath", "workflowRef", "workflowSha", "runId", "runAttempt"],
    "publication workflow",
  );
  const workflow = {
    repository: string(raw.workflow.repository, "workflow.repository"),
    workflowPath: string(raw.workflow.workflowPath, "workflow.workflowPath"),
    workflowRef: string(raw.workflow.workflowRef, "workflow.workflowRef"),
    workflowSha: string(raw.workflow.workflowSha, "workflow.workflowSha"),
    runId: string(raw.workflow.runId, "workflow.runId"),
    runAttempt: string(raw.workflow.runAttempt, "workflow.runAttempt"),
  };
  if (
    workflow.repository !== args.repository ||
    workflow.workflowPath !== ".github/workflows/plugin-npm-release.yml" ||
    workflow.workflowRef !== args.workflowRef ||
    workflow.workflowSha !== args.sourceSha ||
    workflow.runId !== args.runId ||
    workflow.runAttempt !== args.runAttempt
  ) {
    throw new Error("Publication result workflow identity does not match its Actions run.");
  }

  const selectedPackages = collectExtendedStablePublishablePluginPackages(args.root);
  if (selectedPackages.some((plugin) => plugin.version !== releaseVersion)) {
    throw new Error("Publication release version must match the packaged root version.");
  }
  const selectedByName = new Map(selectedPackages.map((plugin) => [plugin.packageName, plugin]));
  const expectedPackageNames = selectedPackages.map((plugin) => plugin.packageName);
  const entries = raw.plugins.map((value, index) => {
    if (!isRecord(value)) {
      throw new Error(`publication plugins[${index}] must be an object.`);
    }
    assertKeys(
      value,
      ["packageName", "version", "npmIntegrity", "candidateTag", "provenanceVerified"],
      `publication plugins[${index}]`,
    );
    const packageName = string(value.packageName, `publication plugins[${index}].packageName`);
    const plugin = selectedByName.get(packageName);
    if (!plugin) {
      throw new Error(`Publication contains unexpected package ${packageName}.`);
    }
    const candidateTag = deriveExtendedStablePluginCandidateTag({
      pluginId: plugin.extensionId,
      version: releaseVersion,
    });
    const integrity = npmIntegrity(`${packageName}@${releaseVersion}`);
    const candidateVersion = npmVersion(`${packageName}@${candidateTag}`);
    if (
      value.version !== releaseVersion ||
      value.npmIntegrity !== integrity ||
      value.candidateTag !== candidateTag ||
      candidateVersion !== releaseVersion ||
      value.provenanceVerified !== true
    ) {
      throw new Error(`Publication result is invalid for ${packageName}.`);
    }
    return { packageName, version: releaseVersion, npmIntegrity: integrity, candidateTag };
  });
  if (
    JSON.stringify(entries.map((entry) => entry.packageName)) !==
    JSON.stringify(expectedPackageNames)
  ) {
    throw new Error(
      "Publication result must contain exactly the patch-derived packages in package-name order.",
    );
  }
  const snapshotVersion = `${releaseVersion.split(".").slice(0, 2).join(".")}.33`;
  const expectedSnapshotNames = collectExtendedStableSnapshotPluginPackages(args.root).map(
    (plugin) => plugin.packageName,
  );
  const snapshotReadbacks = raw.snapshotReadbacks.map((value, index) => {
    if (!isRecord(value)) {
      throw new Error(`snapshot readbacks[${index}] must be an object.`);
    }
    assertKeys(
      value,
      ["packageName", "version", "npmIntegrity", "installVerified"],
      `snapshot readbacks[${index}]`,
    );
    const packageName = string(value.packageName, `snapshot readbacks[${index}].packageName`);
    const integrity = npmIntegrity(`${packageName}@${snapshotVersion}`);
    if (
      value.version !== snapshotVersion ||
      value.npmIntegrity !== integrity ||
      value.installVerified !== true
    ) {
      throw new Error(`Snapshot readback is invalid for ${packageName}.`);
    }
    return { packageName, version: snapshotVersion, npmIntegrity: integrity };
  });
  if (
    JSON.stringify(snapshotReadbacks.map((entry) => entry.packageName)) !==
    JSON.stringify(expectedSnapshotNames)
  ) {
    throw new Error(
      "Publication result must contain exactly the snapshot-only packages in package-name order.",
    );
  }
  return {
    sourceSha: args.sourceSha,
    publicationRunId: args.runId,
    publicationRunAttempt: args.runAttempt,
    publicationArtifactDigest: args.artifactDigest,
    publicationResultSha256: sha256File(args.result),
    plugins: entries,
    snapshotReadbacks,
  };
}

function isMain(): boolean {
  return (
    process.argv[1] !== undefined &&
    import.meta.url === pathToFileURL(resolve(process.argv[1])).href
  );
}

if (isMain()) {
  process.stdout.write(`${JSON.stringify(verifyPublication(parseArgs(process.argv.slice(2))))}\n`);
}
