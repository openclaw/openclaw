import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { ResponsesToolCallState } from "../internal/openai.js";

type StreamingToolCallState = ResponsesToolCallState & {
  block: Record<string, unknown>;
};

export function readResponsesOutputIndex(event: Record<string, unknown>): number | undefined {
  return typeof event.output_index === "number" &&
    Number.isInteger(event.output_index) &&
    event.output_index >= 0
    ? event.output_index
    : undefined;
}

function readIdentityValue(value: unknown): string | undefined {
  const identity = typeof value === "string" ? value.trim() : "";
  return identity || undefined;
}

export function resolveCompletedResponsesToolCallName(
  toolCall: StreamingToolCallState | undefined,
  value: unknown,
): string {
  const streamedName = readIdentityValue(toolCall?.block.name);
  const completedName = readIdentityValue(value);
  if (streamedName && completedName && streamedName !== completedName) {
    throw new Error(
      `Responses stream changed tool-call function name from ${streamedName} to ${completedName}`,
    );
  }
  const name = completedName ?? streamedName;
  if (!name) {
    throw new Error("Responses stream completed tool call without a function name");
  }
  return name;
}

export function isCompleteObjectJson(value: string): boolean {
  try {
    return isRecord(JSON.parse(value) as unknown);
  } catch {
    return false;
  }
}

export function hasCompleteObjectArguments(item: Record<string, unknown>): boolean {
  return typeof item.arguments === "string" && isCompleteObjectJson(item.arguments);
}

function canonicalizeJson(value: unknown): unknown {
  return Array.isArray(value)
    ? value.map(canonicalizeJson)
    : isRecord(value)
      ? Object.fromEntries(
          Object.entries(value)
            .toSorted(([left], [right]) => left.localeCompare(right))
            .map(([key, entryValue]) => [key, canonicalizeJson(entryValue)]),
        )
      : value;
}

export function createAnonymousToolCallFingerprint(name: string, args: unknown): string {
  return `${name}\u0000${JSON.stringify(canonicalizeJson(args))}`;
}
