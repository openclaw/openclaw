#!/usr/bin/env -S node --import tsx

import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  readExtendedStablePluginAcceptanceResult,
  resolveCoveredPlugin,
  sha256File,
} from "./lib/extended-stable-plugin-acceptance.js";

type Args = {
  result: string;
  root: string;
  releaseVersion: string;
  pluginPackageName: string;
  repository: string;
  workflowSha: string;
  runId: number;
  runAttempt: number;
  artifactDigest: string;
};

function parsePositiveInteger(value: string, label: string): number {
  if (!/^\d+$/u.test(value) || Number(value) <= 0 || !Number.isSafeInteger(Number(value))) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return Number(value);
}

function parseArgs(argv: string[]): Args {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined || values.has(key)) {
      throw new Error("Acceptance verifier requires unique --key value arguments.");
    }
    values.set(key, value);
  }
  const required = [
    "--result",
    "--root",
    "--release-version",
    "--plugin-package-name",
    "--repository",
    "--workflow-sha",
    "--run-id",
    "--run-attempt",
    "--artifact-digest",
  ];
  if (values.size !== required.length || required.some((key) => !values.has(key))) {
    throw new Error(`Acceptance verifier requires exactly: ${required.join(", ")}.`);
  }
  return {
    result: values.get("--result")!,
    root: values.get("--root")!,
    releaseVersion: values.get("--release-version")!,
    pluginPackageName: values.get("--plugin-package-name")!,
    repository: values.get("--repository")!,
    workflowSha: values.get("--workflow-sha")!,
    runId: parsePositiveInteger(values.get("--run-id")!, "run id"),
    runAttempt: parsePositiveInteger(values.get("--run-attempt")!, "run attempt"),
    artifactDigest: values.get("--artifact-digest")!,
  };
}

function npmIntegrity(spec: string): string {
  const stdout = execFileSync(
    "npm",
    ["view", spec, "dist.integrity", "--json", "--registry=https://registry.npmjs.org/"],
    {
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
      timeout: 2 * 60 * 1000,
    },
  );
  const value: unknown = JSON.parse(stdout);
  if (typeof value !== "string") {
    throw new Error(`npm did not return an integrity for ${spec}.`);
  }
  return value;
}

export function verifyAcceptance(args: Args) {
  const result = readExtendedStablePluginAcceptanceResult(args.result);
  const plugin = resolveCoveredPlugin(args.root, args.pluginPackageName);
  if (result.inputs.releaseVersion !== args.releaseVersion) {
    throw new Error("Acceptance result release version does not match the requested release.");
  }
  if (result.inputs.pluginPackageName !== plugin.packageName) {
    throw new Error("Acceptance result plugin package does not match the requested plugin.");
  }
  if (result.resolved.acceptanceProfile !== plugin.acceptanceProfile) {
    throw new Error("Acceptance result profile does not match the checked-in support policy.");
  }
  if (
    result.workflow.repository !== args.repository ||
    result.workflow.sha !== args.workflowSha ||
    result.workflow.runId !== args.runId ||
    result.workflow.runAttempt !== args.runAttempt
  ) {
    throw new Error("Acceptance result workflow identity does not match its Actions run.");
  }
  if (result.conclusion !== "succeeded") {
    throw new Error("Acceptance result did not succeed.");
  }
  if (!/^sha256:[0-9a-f]{64}$/u.test(args.artifactDigest)) {
    throw new Error("Acceptance artifact API digest must be sha256:<lowercase hex>.");
  }
  const coreIntegrity = npmIntegrity(`openclaw@${args.releaseVersion}`);
  const pluginIntegrity = npmIntegrity(`${plugin.packageName}@${args.releaseVersion}`);
  if (
    result.resolved.coreIntegrity !== coreIntegrity ||
    result.resolved.pluginIntegrity !== pluginIntegrity
  ) {
    throw new Error("Acceptance result npm integrities do not match fresh registry readback.");
  }
  return {
    packageName: plugin.packageName,
    npmIntegrity: pluginIntegrity,
    workflowSha: result.workflow.sha,
    acceptanceRunId: result.workflow.runId,
    acceptanceRunAttempt: result.workflow.runAttempt,
    acceptanceArtifactDigest: args.artifactDigest,
    acceptanceResultSha256: sha256File(args.result),
  };
}

function isMain(): boolean {
  return (
    process.argv[1] !== undefined &&
    import.meta.url === pathToFileURL(resolve(process.argv[1])).href
  );
}

if (isMain()) {
  process.stdout.write(`${JSON.stringify(verifyAcceptance(parseArgs(process.argv.slice(2))))}\n`);
}
