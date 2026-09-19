/**
 * Normalizes and sanitizes Codex dynamic-tool progress payloads before they are
 * emitted into OpenClaw events or logs.
 */
import {
  inferToolMetaFromArgs,
  sanitizeToolArgs,
  type EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams,
  type ToolProgressDetailMode,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  isJsonObject,
  type CodexDynamicToolCallParams,
  type CodexDynamicToolCallResponse,
  type JsonValue,
} from "./protocol.js";

/** Maps OpenClaw tool-progress config to the mode used by Codex progress metadata. */
export function resolveCodexToolProgressDetailMode(
  value: EmbeddedRunAttemptParams["toolProgressDetail"],
): ToolProgressDetailMode {
  return value === "raw" ? "raw" : "explain";
}

export function isCodexCommandBearingToolCall(
  name: string | undefined,
  args: Record<string, unknown> | undefined,
): boolean {
  const normalizedName = name?.trim().toLowerCase();
  return (
    normalizedName === "exec" ||
    normalizedName === "bash" ||
    normalizedName === "shell" ||
    (typeof args?.command === "string" && args.command.trim().length > 0)
  );
}

/** Sanitizes a record-shaped Codex agent event payload. */
export function sanitizeCodexAgentEventRecord(
  value: Record<string, unknown>,
): Record<string, unknown> {
  return sanitizeToolArgs(value) as Record<string, unknown>;
}

/** Sanitizes dynamic-tool arguments before diagnostic/event emission. */
export function sanitizeCodexToolArguments(
  value: JsonValue | undefined,
): Record<string, unknown> | undefined {
  if (!isJsonObject(value)) {
    return undefined;
  }
  return sanitizeCodexAgentEventRecord(value);
}

/** Sanitizes a Codex dynamic-tool response before diagnostic/event emission. */
export function sanitizeCodexToolResponse(
  response: CodexDynamicToolCallResponse,
): Record<string, unknown> {
  return sanitizeCodexAgentEventRecord({ ...response });
}

/** Infers compact human-readable tool metadata from Codex dynamic-tool arguments. */
export function inferCodexDynamicToolMeta(
  call: Pick<CodexDynamicToolCallParams, "tool" | "arguments">,
  detailMode: ToolProgressDetailMode,
): string | undefined {
  return inferToolMetaFromArgs(call.tool, call.arguments, { detailMode });
}
