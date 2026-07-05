#!/usr/bin/env -S node --import tsx

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  assertExtendedStableReleaseVersion,
  sha256File,
} from "./lib/extended-stable-plugin-acceptance.js";
import { loadExtendedStablePluginSupport } from "./lib/extended-stable-plugin-support.js";

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
  assertKeys(raw, ["schemaVersion", "sourceSha", "workflow", "plugins"], "publication result");
  if (raw.schemaVersion !== 1 || raw.sourceSha !== args.sourceSha || !Array.isArray(raw.plugins)) {
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

  const support = loadExtendedStablePluginSupport(args.root);
  const expectedPackageNames = support.plugins.map((plugin) => plugin.packageName);
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
    const plugin = support.plugins.find((candidate) => candidate.packageName === packageName);
    if (!plugin) {
      throw new Error(`Publication contains uncovered package ${packageName}.`);
    }
    const [year, month, patch] = releaseVersion.split(".");
    const candidateTag = `extended-stable-plugin-candidate-${plugin.pluginId}-${year}-${month}-${patch}`;
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
      "Publication result must contain exactly the covered packages in package-name order.",
    );
  }
  return {
    sourceSha: args.sourceSha,
    publicationRunId: args.runId,
    publicationRunAttempt: args.runAttempt,
    publicationArtifactDigest: args.artifactDigest,
    publicationResultSha256: sha256File(args.result),
    plugins: entries,
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
