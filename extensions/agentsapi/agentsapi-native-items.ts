import {
  TOOL_TRANSCRIPT_OUTPUT_MAX_CHARS,
  truncateNativeToolTranscriptText,
} from "openclaw/plugin-sdk/agent-harness-attempt-runtime";
import {
  inferToolMetaFromArgs,
  sanitizeToolArgs,
  sanitizeToolResult,
  type AgentHarnessAttemptParamsV2,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { AgentsApiItem } from "./agentsapi-client.js";

export type AgentsApiNativeTool = {
  name: string;
  args: Record<string, unknown>;
  meta?: string;
  commandBearing: boolean;
};

export type AgentsApiNativeToolOutcome = {
  status: "running" | "completed" | "failed" | "cancelled" | "unknown";
  isError: boolean;
  outcomeUnknown: boolean;
  error?: string;
  errorCode?: string;
};

export function agentsApiNativeTool(
  item: AgentsApiItem,
  params: AgentHarnessAttemptParamsV2,
): AgentsApiNativeTool | undefined {
  let name: string;
  let args: Record<string, unknown>;
  if (item.type === "command_execution") {
    name = "bash";
    args = {
      ...(item.command !== undefined ? { command: item.command } : {}),
      ...(typeof item.cwd === "string" ? { cwd: item.cwd } : {}),
    };
  } else if (item.type === "mcp_call") {
    name = item.server_label ? `${item.server_label}.${item.name ?? "mcp"}` : (item.name ?? "mcp");
    args =
      asOptionalRecord(item.arguments) ??
      (item.arguments === undefined ? {} : { arguments: item.arguments });
  } else if (item.type === "web_search_call") {
    name = "web_search";
    args = item.action ? { ...item.action } : {};
  } else {
    return undefined;
  }
  args = asOptionalRecord(sanitizeToolArgs(args)) ?? {};
  const meta = inferToolMetaFromArgs(name, args, {
    detailMode: params.toolProgressDetail === "raw" ? "raw" : "explain",
  });
  return {
    name,
    args,
    ...(meta ? { meta } : {}),
    commandBearing: item.type === "command_execution",
  };
}

export function agentsApiNativeToolOutcome(
  item: AgentsApiItem,
  enclosingStatus?: string,
): AgentsApiNativeToolOutcome {
  const nativeError = item.error === null || item.error === undefined ? undefined : item.error;
  const errorRecord = asOptionalRecord(nativeError);
  const errorCode = typeof errorRecord?.code === "string" ? errorRecord.code : undefined;
  const errorText = nativeError === undefined ? undefined : nativeValueText(nativeError);
  const failedCommand =
    item.type === "command_execution" && typeof item.exit_code === "number" && item.exit_code !== 0;
  let status: AgentsApiNativeToolOutcome["status"];
  if (item.status === "failed" || nativeError !== undefined || failedCommand) {
    status = "failed";
  } else if (item.status === "completed") {
    status = item.type === "command_execution" && item.exit_code == null ? "unknown" : "completed";
  } else if (item.status === "in_progress" && enclosingStatus === undefined) {
    status = "running";
  } else if (
    (item.status === "incomplete" || item.status === "in_progress") &&
    enclosingStatus === "cancelled"
  ) {
    status = "cancelled";
  } else {
    status = "unknown";
  }
  const error =
    status === "failed"
      ? errorText ||
        (failedCommand
          ? `Command exited with code ${item.exit_code}`
          : "Agents API native tool failed")
      : status === "cancelled"
        ? "Agents API native tool was cancelled"
        : status === "unknown"
          ? "Agents API native tool outcome is unavailable"
          : undefined;
  return {
    status,
    isError: status !== "completed" && status !== "running",
    outcomeUnknown: status === "unknown",
    ...(error ? { error } : {}),
    ...(errorCode ? { errorCode } : {}),
  };
}

export function agentsApiNativeToolDetails(
  sessionId: string,
  turnId: string,
  item: AgentsApiItem,
  outcome: AgentsApiNativeToolOutcome,
  capturedOutput?: string,
): Record<string, unknown> {
  const nativeOutput = item.output ?? capturedOutput;
  const output =
    nativeOutput === undefined || nativeOutput === null
      ? undefined
      : boundedNativeValue(nativeOutput);
  return (
    asOptionalRecord(
      sanitizeToolResult({
        status: outcome.status,
        native: {
          backend: "agentsapi",
          sessionId,
          turnId,
          itemId: item.id,
          itemType: item.type,
          status: item.status ?? null,
        },
        ...(typeof item.exit_code === "number" ? { exitCode: item.exit_code } : {}),
        ...(typeof item.duration_ms === "number" ? { durationMs: item.duration_ms } : {}),
        ...(typeof item.cwd === "string" ? { cwd: item.cwd } : {}),
        ...(item.server_label ? { serverLabel: item.server_label } : {}),
        ...(item.type === "web_search_call"
          ? { ...(item.action ? { action: item.action } : {}), resultAvailability: "unavailable" }
          : {
              outputAvailability:
                output === undefined
                  ? "unavailable"
                  : item.output == null
                    ? "partial"
                    : "canonical",
              ...(output
                ? { output: output.value, ...(output.truncated ? { outputTruncated: true } : {}) }
                : {}),
            }),
        ...(item.error != null ? { nativeError: boundedNativeValue(item.error).value } : {}),
        ...(outcome.error ? { error: outcome.error } : {}),
        ...(outcome.errorCode ? { errorCode: outcome.errorCode } : {}),
        ...(outcome.outcomeUnknown ? { outcomeUnknown: true } : {}),
      }),
    ) ?? {}
  );
}

export function agentsApiNativeToolOutput(
  item: AgentsApiItem,
  streamed?: string,
): string | undefined {
  if (item.type === "web_search_call") {
    return undefined;
  }
  return item.output !== undefined && item.output !== null
    ? nativeValueText(item.output)
    : streamed;
}

function nativeValueText(value: unknown): string {
  const sanitized = sanitizeNativeValue(value);
  const text =
    typeof sanitized === "string" ? sanitized : (JSON.stringify(sanitized, null, 2) ?? "");
  return truncateNativeToolTranscriptText(text, "Agents API");
}

function boundedNativeValue(value: unknown): { value: unknown; truncated: boolean } {
  const sanitized = sanitizeNativeValue(value);
  const text =
    typeof sanitized === "string" ? sanitized : (JSON.stringify(sanitized, null, 2) ?? "");
  return text.length <= TOOL_TRANSCRIPT_OUTPUT_MAX_CHARS
    ? { value: sanitized, truncated: false }
    : { value: truncateNativeToolTranscriptText(text, "Agents API"), truncated: true };
}

function sanitizeNativeValue(value: unknown): unknown {
  return Array.isArray(value)
    ? asOptionalRecord(sanitizeToolResult({ content: value }))?.content
    : sanitizeToolResult(value);
}
