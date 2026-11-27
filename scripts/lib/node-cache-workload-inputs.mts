import { lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { isRecord } from "../../packages/normalization-core/src/record-coerce.ts";
import {
  sha256,
  validateNodeCacheManifest,
  type NodeCacheManifest,
} from "./vitest-pair-benchmark-contract.mts";

export type WorkloadDefinition = {
  version: 1;
  kind: "node-cache-workload-definition";
  workloadSha: string;
  workloadTree: string;
  lane: NodeCacheManifest["lane"];
  expected: NodeCacheManifest["expected"];
  runtime: NodeCacheManifest["runtime"];
  pnpmVersion: string;
  sourceIdentities: Array<{ path: string; sha256: string }>;
};

const digestPattern = /^[0-9a-f]{64}$/u;
const shaPattern = /^[0-9a-f]{40}$/u;

export function validateWorkloadDefinition(value: unknown): WorkloadDefinition {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    value.kind !== "node-cache-workload-definition" ||
    typeof value.workloadTree !== "string" ||
    !shaPattern.test(value.workloadTree) ||
    typeof value.pnpmVersion !== "string" ||
    value.pnpmVersion !== "12.15.0" ||
    !Array.isArray(value.sourceIdentities) ||
    value.sourceIdentities.length !== 5 ||
    !Array.isArray(value.expected) ||
    value.expected.length !== 20
  ) {
    throw new Error(
      "Workload definition requires a pinned tree, version, five sources and 20 cases",
    );
  }
  const inputs = value.sourceIdentities.map((entry) => {
    if (
      !isRecord(entry) ||
      typeof entry.path !== "string" ||
      typeof entry.sha256 !== "string" ||
      !digestPattern.test(entry.sha256)
    ) {
      throw new Error("Invalid workload source identity");
    }
    return { path: entry.path, sha256: entry.sha256, bytes: 0 };
  });
  // Reuse the existing lane, path, runtime and oracle validation. This is not a
  // timing manifest: placeholder sizes/seed never leave this validation boundary.
  const checked = validateNodeCacheManifest({
    ...value,
    version: 2,
    mode: "node-compile-cache",
    pnpmSha256: "0".repeat(64),
    inputs,
    seed: { files: [{ path: "validation-only", bytes: 0, sha256: "0".repeat(64) }] },
  });
  if (
    !isRecord(value.lane) ||
    value.lane.critical !== true ||
    checked.runtime.architecture !== "x64" ||
    !inputs.some((entry) => entry.path === "package.json") ||
    !inputs.some((entry) => entry.path === "pnpm-lock.yaml") ||
    new Set(
      checked.expected.map(({ file, fullName, line, column }) =>
        JSON.stringify([file, fullName, line, column]),
      ),
    ).size !== 20
  ) {
    throw new Error("Workload definition requires unique cases and complete source identities");
  }
  // Drop provenance and all other unknown fields instead of copying private input metadata.
  return {
    version: 1,
    kind: "node-cache-workload-definition",
    workloadSha: checked.workloadSha,
    workloadTree: value.workloadTree,
    lane: {
      id: checked.lane.id,
      critical: checked.lane.critical,
      config: checked.lane.config,
      files: [...checked.lane.files],
    },
    expected: checked.expected.map(({ file, fullName, line, column, status }) => ({
      file,
      fullName,
      line,
      column,
      status,
    })),
    runtime: {
      node: checked.runtime.node,
      v8: checked.runtime.v8,
      platform: checked.runtime.platform,
      architecture: checked.runtime.architecture,
      executableSha256: checked.runtime.executableSha256,
    },
    pnpmVersion: value.pnpmVersion,
    sourceIdentities: inputs.map(({ path: file, sha256: hash }) => ({ path: file, sha256: hash })),
  };
}

export function assertDefinitionSources(workload: string, definition: WorkloadDefinition) {
  for (const entry of definition.sourceIdentities) {
    const file = path.join(workload, entry.path);
    if (
      !realpathSync(file).startsWith(workload + path.sep) ||
      !lstatSync(file).isFile() ||
      sha256(readFileSync(file)) !== entry.sha256
    ) {
      throw new Error(`Pinned workload source differs: ${entry.path}`);
    }
  }
}

export function hashPreparedPnpmExecutable(file: string): string {
  if (!path.isAbsolute(file) || realpathSync(file) !== file) {
    throw new Error("Prepared pnpm must be an absolute physical executable");
  }
  const stat = lstatSync(file);
  if (!stat.isFile() || (stat.mode & 0o111) === 0) {
    throw new Error("Prepared pnpm must be a regular executable");
  }
  const bytes = readFileSync(file);
  if (
    bytes.length < 20 ||
    bytes.subarray(0, 4).toString("hex") !== "7f454c46" ||
    bytes[4] !== 2 ||
    bytes[5] !== 1 ||
    bytes[6] !== 1 ||
    bytes.readUInt16LE(18) !== 62
  ) {
    throw new Error("Prepared pnpm must be a Linux ELF64 little-endian x86_64 executable");
  }
  return sha256(bytes);
}
