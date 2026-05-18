import { createHash } from "node:crypto";
import type { SubagentCapabilityPreflightResult } from "./subagent-capabilities.js";

export const SUBAGENT_ACCEPTANCE_VERDICT_SCHEMA_VERSION = 1 as const;
export const SUBAGENT_TASK_PACKET_OVERSIZE = "BLOCKED_TASK_PACKET_OVERSIZE" as const;

export const SUBAGENT_DISPATCH_DEFAULT_FILE_REFERENCE_LIMIT = 80 as const;
export const SUBAGENT_DISPATCH_DEFAULT_TASK_PACKET_BYTES = 64 * 1024;
export const SUBAGENT_DISPATCH_DEFAULT_READ_BYTES_SOFT_LIMIT = 256 * 1024;
export const SUBAGENT_DISPATCH_DEFAULT_FINAL_OUTPUT_BYTES = 4 * 1024;

export type SubagentTaskSizingRequest = {
  sourceHeavy?: unknown;
  fileReferenceLimit?: unknown;
  taskPacketByteLimit?: unknown;
  readByteSoftLimit?: unknown;
  finalOutputByteLimit?: unknown;
  primaryObjectives?: unknown;
  requiresLogRedirection?: unknown;
};

export type SubagentTaskSizingBudget = {
  sourceHeavy: boolean;
  fileReferenceLimit: number;
  taskPacketByteLimit: number;
  readByteSoftLimit: number;
  finalOutputByteLimit: number;
  primaryObjectives?: number;
  requiresLogRedirection: boolean;
  fileReferenceCount: number;
  taskPacketBytes: number;
  estimatedEmbeddedReadBytes: number;
};

export type SubagentTaskSizingPreflightResult =
  | {
      ok: true;
      budget: SubagentTaskSizingBudget;
      instructions: string;
    }
  | {
      ok: false;
      code: typeof SUBAGENT_TASK_PACKET_OVERSIZE;
      message: string;
      reasons: string[];
      budget: SubagentTaskSizingBudget;
    };

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

function normalizePositiveInteger(value: unknown, fallback: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.min(max, Math.max(1, Math.floor(value)));
}

function normalizeOptionalPositiveInteger(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return Math.floor(value);
}

function countFileReferences(text: string): number {
  const matches = text.match(
    /(?:^|[\s`'"(])(?:\.?\.?\/)?[A-Za-z0-9_@./-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|mdx|yaml|yml|toml|py|sh|bash|go|rs|java|kt|swift|css|scss|html|sql)(?::\d+(?::\d+)?)?/gm,
  );
  return matches?.length ?? 0;
}

function estimateEmbeddedSourceBytes(text: string): number {
  const fenced = [...text.matchAll(/```[\s\S]*?```/g)].reduce(
    (sum, match) => sum + byteLength(match[0]),
    0,
  );
  const sourceLikeLines = text
    .split("\n")
    .filter((line) =>
      /^\s*(?:diff --git|@@|import\s|export\s|(?:async\s+)?function\s|class\s|(?:const|let|var)\s|[+-]{3}\s)/.test(
        line,
      ),
    )
    .join("\n");
  return fenced + byteLength(sourceLikeLines);
}

function inferSourceHeavy(task: string, requested: unknown, fileReferenceCount: number): boolean {
  if (requested === true) {
    return true;
  }
  if (requested === false) {
    return false;
  }
  return (
    fileReferenceCount > 20 ||
    /```[\s\S]{512,}```/.test(task) ||
    /(^|\n)\s*(?:diff --git|@@|import\s|export\s|(?:async\s+)?function\s|class\s|(?:const|let|var)\s)/.test(
      task,
    )
  );
}

export function evaluateSubagentTaskSizingPreflight(params: {
  task: string;
  request?: SubagentTaskSizingRequest;
}): SubagentTaskSizingPreflightResult {
  const task = params.task ?? "";
  const taskPacketBytes = byteLength(task);
  const fileReferenceCount = countFileReferences(task);
  const estimatedEmbeddedReadBytes = estimateEmbeddedSourceBytes(task);
  const sourceHeavy = inferSourceHeavy(task, params.request?.sourceHeavy, fileReferenceCount);
  const primaryObjectives = normalizeOptionalPositiveInteger(params.request?.primaryObjectives);
  const budget: SubagentTaskSizingBudget = {
    sourceHeavy,
    fileReferenceLimit: normalizePositiveInteger(
      params.request?.fileReferenceLimit,
      SUBAGENT_DISPATCH_DEFAULT_FILE_REFERENCE_LIMIT,
      500,
    ),
    taskPacketByteLimit: normalizePositiveInteger(
      params.request?.taskPacketByteLimit,
      SUBAGENT_DISPATCH_DEFAULT_TASK_PACKET_BYTES,
      1024 * 1024,
    ),
    readByteSoftLimit: normalizePositiveInteger(
      params.request?.readByteSoftLimit,
      SUBAGENT_DISPATCH_DEFAULT_READ_BYTES_SOFT_LIMIT,
      4 * 1024 * 1024,
    ),
    finalOutputByteLimit: normalizePositiveInteger(
      params.request?.finalOutputByteLimit,
      SUBAGENT_DISPATCH_DEFAULT_FINAL_OUTPUT_BYTES,
      64 * 1024,
    ),
    ...(primaryObjectives ? { primaryObjectives } : {}),
    requiresLogRedirection: params.request?.requiresLogRedirection !== false,
    fileReferenceCount,
    taskPacketBytes,
    estimatedEmbeddedReadBytes,
  };

  const reasons: string[] = [];
  if (sourceHeavy && taskPacketBytes > budget.taskPacketByteLimit) {
    reasons.push(`SOURCE_HEAVY_TASK_PACKET_BYTES:${taskPacketBytes}>${budget.taskPacketByteLimit}`);
  }
  if (sourceHeavy && fileReferenceCount > budget.fileReferenceLimit) {
    reasons.push(`SOURCE_HEAVY_FILE_REFERENCES:${fileReferenceCount}>${budget.fileReferenceLimit}`);
  }
  if (sourceHeavy && estimatedEmbeddedReadBytes > budget.readByteSoftLimit) {
    reasons.push(
      `SOURCE_HEAVY_READ_BYTES:${estimatedEmbeddedReadBytes}>${budget.readByteSoftLimit}`,
    );
  }
  if (typeof budget.primaryObjectives === "number" && budget.primaryObjectives > 1) {
    reasons.push(`TASK_BREADTH_PRIMARY_OBJECTIVES:${budget.primaryObjectives}>1`);
  }

  if (reasons.length > 0) {
    return {
      ok: false,
      code: SUBAGENT_TASK_PACKET_OVERSIZE,
      message: `${SUBAGENT_TASK_PACKET_OVERSIZE}: ${reasons.join("; ")}`,
      reasons,
      budget,
    };
  }

  return {
    ok: true,
    budget,
    instructions: formatSubagentTaskSizingInstructions(budget),
  };
}

export function formatSubagentTaskSizingInstructions(budget: SubagentTaskSizingBudget): string {
  return [
    "Dispatch/task budget contract:",
    `- Keep final chat under ${budget.finalOutputByteLimit} bytes and do not include broad source listings, diffs, grep dumps, or test logs as final evidence.`,
    `- Source-heavy reads have soft limits: ${budget.fileReferenceLimit} file references and ${budget.readByteSoftLimit} read bytes unless the parent narrows/splits the task.`,
    budget.requiresLogRedirection
      ? "- Redirect command stdout/stderr to log files by default; cite log paths/hashes in the verdict artifact instead of pasting logs."
      : "- Keep command output bounded; cite log paths/hashes when logs exist.",
    "- Focus on one primary objective; if scope is broader, stop with blockers instead of expanding the packet.",
  ].join("\n");
}

export function buildSubagentVerdictArtifactId(params: {
  childSessionKey: string;
  artifactOutputPath: string;
  taskLabel?: string;
}): string {
  const hash = sha256Hex(
    [params.childSessionKey, params.artifactOutputPath, params.taskLabel ?? ""].join("\u0000"),
  );
  return `verdict_${hash.slice(0, 24)}`;
}

export function buildSubagentAcceptanceContractInstructions(params: {
  capabilityPreflight: SubagentCapabilityPreflightResult;
  childSessionKey: string;
  taskLabel?: string;
  taskSizingInstructions?: string;
}): string | undefined {
  if (!params.capabilityPreflight.ok) {
    return undefined;
  }
  const artifactOutputPath = params.capabilityPreflight.normalized.artifactOutputPath;
  if (!artifactOutputPath) {
    return params.taskSizingInstructions;
  }
  const artifactId = buildSubagentVerdictArtifactId({
    childSessionKey: params.childSessionKey,
    artifactOutputPath,
    taskLabel: params.taskLabel,
  });
  const logOutputPath = params.capabilityPreflight.normalized.logOutputPath;
  const lines = [
    "Acceptance-gated verdict artifact contract:",
    `- schemaVersion: ${SUBAGENT_ACCEPTANCE_VERDICT_SCHEMA_VERSION}; artifactId: ${artifactId}; artifactPath: ${artifactOutputPath}`,
    "- Write the verdict artifact before final chat. Use valid JSON with schemaVersion, artifactId, verdict/status, blockers, changedPaths, tests/evidence, and log/artifact hashes where applicable.",
    "- Final chat must only report artifact path or id, sha256/hash if known, status, and blockers. Do not paste source, diffs, raw command output, or logs.",
    "- Parent/runtime will read the artifact path and independently verify evidence; PASS text alone is not acceptance.",
    logOutputPath
      ? `- Redirect long command output to ${logOutputPath} or sibling log files and cite paths/hashes in the artifact.`
      : "- Redirect long command output to log files and cite paths/hashes in the artifact.",
  ];
  if (params.taskSizingInstructions) {
    lines.push("", params.taskSizingInstructions);
  }
  return lines.join("\n");
}
