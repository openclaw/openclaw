import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import {
  DEFAULT_SANDBOX_BASELINE,
  resolveSandboxBaseline,
  type BaselineFilesystemPolicyInput,
  type SandboxBaselinePolicy,
  type SandboxBaselinePolicyInput,
} from "./sandbox-baseline.js";

export type SandboxPolicyLoaderOptions = {
  policyPaths?: readonly string[];
};

export type SandboxPolicyLayer = SandboxBaselinePolicyInput;

export type SandboxPolicySource = {
  label: string;
  policy: SandboxPolicyLayer;
};

const stringArraySchema = z.array(z.string());
const hardeningBooleanSchema = z.literal(true);
const filesystemPolicySchema = z
  .object({
    restrictToProjectDir: hardeningBooleanSchema.optional(),
    additionalReadonlyPaths: stringArraySchema.optional(),
    additionalReadwritePaths: stringArraySchema.optional(),
  })
  .strict();
const processPolicySchema = z
  .object({
    timeoutSeconds: z.number().finite().min(1).optional(),
  })
  .strict();

export const SandboxPolicyLayerSchema = z
  .object({
    filesystem: filesystemPolicySchema.optional(),
    process: processPolicySchema.optional(),
  })
  .strict();

export function loadSandboxBaselinePolicy(
  options: SandboxPolicyLoaderOptions = {},
): SandboxBaselinePolicy {
  const sources: SandboxPolicySource[] = [];

  for (const policyPath of options.policyPaths ?? []) {
    const policy = readSandboxPolicyFile(policyPath);
    if (policy) {
      sources.push({ label: policyPath, policy });
    }
  }

  const merged = mergeSandboxPolicyLayers(sources);
  const resolved = resolveSandboxBaseline(merged);
  const timeoutSecondsConfigured = sources.some(
    ({ policy }) => policy.process?.timeoutSeconds !== undefined,
  );
  resolved.process.timeoutSecondsConfigured = timeoutSecondsConfigured;
  return resolved;
}

export function readSandboxPolicyFile(policyPath: string): SandboxBaselinePolicyInput | undefined {
  if (!existsSync(policyPath)) {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(policyPath, "utf-8"));
  } catch (err) {
    if (isNodeError(err) && err.code === "ENOENT") {
      return undefined;
    }
    throw policyFileError(policyPath, err);
  }

  try {
    return parseSandboxPolicyLayer(parsed, policyPath);
  } catch (err) {
    throw policyFileError(policyPath, err);
  }
}

export function parseSandboxPolicyLayer(
  value: unknown,
  sourceLabel: string,
): SandboxBaselinePolicyInput {
  const parsed = SandboxPolicyLayerSchema.safeParse(value);
  if (!parsed.success) {
    throw new TypeError(formatSandboxPolicyIssue(sourceLabel, parsed.error.issues[0]));
  }

  return parsed.data;
}

export function mergeSandboxPolicyLayers(
  sources: readonly SandboxPolicySource[],
): SandboxBaselinePolicyInput {
  const timeoutCandidates = [DEFAULT_SANDBOX_BASELINE.process.timeoutSeconds];
  const filesystem: BaselineFilesystemPolicyInput = {
    restrictToProjectDir: DEFAULT_SANDBOX_BASELINE.filesystem.restrictToProjectDir,
    additionalReadonlyPaths: [],
    additionalReadwritePaths: [],
  };

  for (const { policy, label } of sources) {
    mergeFilesystemPolicy(filesystem, policy.filesystem);
    const timeoutSeconds = policy.process?.timeoutSeconds;
    if (timeoutSeconds !== undefined) {
      assertPositiveFiniteNumber(timeoutSeconds, `${label}.process.timeoutSeconds`);
      timeoutCandidates.push(timeoutSeconds);
    }
  }

  return {
    filesystem: {
      ...filesystem,
      additionalReadonlyPaths: dedupeStable(filesystem.additionalReadonlyPaths ?? []),
      additionalReadwritePaths: dedupeStable(filesystem.additionalReadwritePaths ?? []),
    },
    process: {
      timeoutSeconds: Math.min(...timeoutCandidates),
    },
  };
}

function mergeFilesystemPolicy(
  target: BaselineFilesystemPolicyInput | undefined,
  layer: BaselineFilesystemPolicyInput | undefined,
): void {
  if (!target || !layer) {
    return;
  }

  target.restrictToProjectDir = mostRestrictiveBoolean(
    DEFAULT_SANDBOX_BASELINE.filesystem.restrictToProjectDir,
    target.restrictToProjectDir,
    layer.restrictToProjectDir,
  );
  target.additionalReadonlyPaths = [
    ...(target.additionalReadonlyPaths ?? []),
    ...(layer.additionalReadonlyPaths ?? []),
  ];
  target.additionalReadwritePaths = [
    ...(target.additionalReadwritePaths ?? []),
    ...(layer.additionalReadwritePaths ?? []),
  ];
}

function mostRestrictiveBoolean(
  defaultValue: boolean,
  ...values: readonly (boolean | undefined)[]
): boolean {
  return defaultValue || values.some((value) => value === true);
}

function assertPositiveFiniteNumber(value: unknown, label: string): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1) {
    throw new TypeError(`Sandbox policy field ${label} must be a positive number.`);
  }
}

function dedupeStable(values: readonly string[]): string[] {
  const deduped: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (!seen.has(value)) {
      seen.add(value);
      deduped.push(value);
    }
  }
  return deduped;
}

function formatSandboxPolicyIssue(sourceLabel: string, issue: z.ZodIssue | undefined): string {
  if (!issue) {
    return `Sandbox policy at ${sourceLabel} is invalid.`;
  }
  if (issue.path.length === 0 && issue.code === "invalid_type") {
    return `Sandbox policy at ${sourceLabel} must be a JSON object.`;
  }

  const fieldLabel = `${sourceLabel}${formatIssuePath(issue.path)}`;
  if (issue.code === "unrecognized_keys" && issue.keys.length > 0) {
    return `Sandbox policy field ${fieldLabel}.${issue.keys[0]} is not supported.`;
  }
  if (issue.code === "invalid_type" && issue.path.length === 1) {
    return `Sandbox policy section ${fieldLabel} must be a JSON object.`;
  }
  if (issue.code === "invalid_type") {
    return `Sandbox policy field ${fieldLabel} ${issue.message}.`;
  }
  if (issue.code === "too_small") {
    return `Sandbox policy field ${fieldLabel} must be a positive number.`;
  }
  return `Sandbox policy field ${fieldLabel} ${issue.message}.`;
}

function formatIssuePath(path: readonly PropertyKey[]): string {
  if (path.length === 0) {
    return "";
  }
  return path
    .map((segment) => (typeof segment === "number" ? `[${segment}]` : `.${String(segment)}`))
    .join("");
}

function policyFileError(policyPath: string, err: unknown): Error {
  const reason = err instanceof Error ? err.message : String(err);
  return new Error(`Failed to load sandbox policy file at ${policyPath}: ${reason}`);
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}
