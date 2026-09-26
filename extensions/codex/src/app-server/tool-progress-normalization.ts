import {
  sanitizeToolArgs,
  type EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams,
  type ToolProgressDetailMode,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { isJsonObject, type JsonValue } from "./protocol.js";

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

export function sanitizeCodexAgentEventRecord(
  value: Record<string, unknown>,
): Record<string, unknown> {
  return sanitizeToolArgs(value) as Record<string, unknown>;
}

export function sanitizeCodexToolArguments(
  value: JsonValue | undefined,
): Record<string, unknown> | undefined {
  if (!isJsonObject(value)) {
    return undefined;
  }
  return sanitizeCodexAgentEventRecord(value);
}
