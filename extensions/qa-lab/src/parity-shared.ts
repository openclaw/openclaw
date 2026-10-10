import { createHash } from "node:crypto";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

type ParityToolCallShape = {
  argsHash: string;
  tool: string;
};

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeForStableHash(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeForStableHash(entry));
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .toSorted((left, right) => left.localeCompare(right))
        .map((key) => [key, normalizeForStableHash(record[key])]),
    );
  }
  return value;
}

export function stableHash(value: unknown) {
  return sha256(JSON.stringify(normalizeForStableHash(value)) ?? "null");
}

function compareToolCallShape(
  left: readonly ParityToolCallShape[],
  right: readonly ParityToolCallShape[],
): string | undefined {
  if (left.length !== right.length) {
    return `tool call count differs (${left.length} vs ${right.length})`;
  }
  for (let index = 0; index < left.length; index += 1) {
    const leftCall = left[index];
    const rightCall = right[index];
    if (!leftCall || !rightCall) {
      return `tool call row ${index + 1} missing`;
    }
    if (leftCall.tool !== rightCall.tool || leftCall.argsHash !== rightCall.argsHash) {
      return `tool call ${index + 1} differs (${leftCall.tool}/${leftCall.argsHash} vs ${rightCall.tool}/${rightCall.argsHash})`;
    }
  }
  return undefined;
}

export function normalizeTextForParity(text: string) {
  return text.replace(/\s+/gu, " ").trim();
}

type ParityToolResultShape = {
  tool: string;
  resultHash: string;
  errorClass?: string;
};

function compareToolResultShape(
  left: readonly ParityToolResultShape[],
  right: readonly ParityToolResultShape[],
  allowedSharedErrorClass?: "tool-result-error",
): string | undefined {
  const total = Math.min(left.length, right.length);
  for (let index = 0; index < total; index += 1) {
    const leftCall = left[index];
    const rightCall = right[index];
    if (!leftCall || !rightCall) {
      continue;
    }
    if (
      allowedSharedErrorClass &&
      leftCall.errorClass === allowedSharedErrorClass &&
      rightCall.errorClass === allowedSharedErrorClass
    ) {
      continue;
    }
    if (
      leftCall.resultHash !== rightCall.resultHash ||
      (leftCall.errorClass ?? "") !== (rightCall.errorClass ?? "")
    ) {
      return `tool result ${index + 1} differs (${leftCall.tool})`;
    }
  }
  return undefined;
}

type ParityBehaviorCell = {
  toolCalls: readonly (ParityToolCallShape & ParityToolResultShape)[];
  transcriptBytes: string;
  finalText: string;
};

type ParityBehaviorDrift =
  | { drift: "none" }
  | {
      drift: "tool-call-shape" | "tool-result-shape" | "structural" | "text-only";
      driftDetails: string;
    };

function countParityTranscriptRecords(transcriptBytes: string, mode?: "lines" | "messages") {
  if (mode !== "messages") {
    return transcriptBytes.trim().length ? transcriptBytes.trim().split(/\r?\n/u).length : 0;
  }
  let count = 0;
  for (const line of transcriptBytes.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (
        isRecord(parsed) &&
        ((isRecord(parsed.message) && typeof parsed.message.role === "string") ||
          typeof parsed.role === "string")
      ) {
        count += 1;
      }
    } catch {
      // Ignore malformed QA transcript rows and keep parity classification deterministic.
    }
  }
  return count;
}

export function compareParityBehavior(params: {
  left: ParityBehaviorCell;
  right: ParityBehaviorCell;
  compareStructure?: boolean;
  allowedSharedErrorClass?: "tool-result-error";
  transcriptMode?: "lines" | "messages";
}): ParityBehaviorDrift {
  const { left, right } = params;
  if (params.compareStructure !== false) {
    const toolCallDrift = compareToolCallShape(left.toolCalls, right.toolCalls);
    if (toolCallDrift) {
      return { drift: "tool-call-shape", driftDetails: toolCallDrift };
    }
    const toolResultDrift = compareToolResultShape(
      left.toolCalls,
      right.toolCalls,
      params.allowedSharedErrorClass,
    );
    if (toolResultDrift) {
      return { drift: "tool-result-shape", driftDetails: toolResultDrift };
    }
    const leftCount = countParityTranscriptRecords(left.transcriptBytes, params.transcriptMode);
    const rightCount = countParityTranscriptRecords(right.transcriptBytes, params.transcriptMode);
    if (leftCount !== rightCount || Boolean(left.finalText) !== Boolean(right.finalText)) {
      const counts =
        params.transcriptMode === "messages"
          ? `${leftCount} message records vs ${rightCount} message records`
          : `${leftCount} lines vs ${rightCount}`;
      return {
        drift: "structural",
        driftDetails: `transcript/final-text structure differs (${counts})`,
      };
    }
  }
  return normalizeTextForParity(left.finalText) === normalizeTextForParity(right.finalText)
    ? { drift: "none" }
    : { drift: "text-only", driftDetails: "final text differs after whitespace normalization" };
}
