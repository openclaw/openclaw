/**
 * Trusted diagnostics emitted around Codex dynamic tool execution lifecycle.
 */
import { emitTrustedDiagnosticEvent } from "openclaw/plugin-sdk/diagnostic-runtime";
import type { CodexDynamicToolRuntimeResponse } from "./dynamic-tool-response-state.js";
import type { CodexDynamicToolCallParams } from "./protocol.js";

type DynamicToolDiagnosticContext = {
  call: CodexDynamicToolCallParams;
  agentId?: string | undefined;
  runId?: string | undefined;
  sessionId?: string | undefined;
  sessionKey?: string | undefined;
};

function diagnosticToolIdentity(params: DynamicToolDiagnosticContext) {
  return {
    agentId: params.agentId,
    runId: params.runId,
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    toolName: params.call.tool,
    toolCallId: params.call.callId,
  };
}

/** Emits a start event for one Codex dynamic tool call. */
export function emitDynamicToolStartedDiagnostic(params: DynamicToolDiagnosticContext): void {
  emitTrustedDiagnosticEvent({
    type: "tool.execution.started",
    ...diagnosticToolIdentity(params),
  });
}

/** Emits an error event for one Codex dynamic tool call. */
export function emitDynamicToolErrorDiagnostic(
  params: DynamicToolDiagnosticContext & {
    durationMs: number;
    terminalReason?: "failed" | "cancelled" | "timed_out";
  },
): void {
  emitTrustedDiagnosticEvent({
    type: "tool.execution.error",
    ...diagnosticToolIdentity(params),
    durationMs: params.durationMs,
    errorCategory: "codex_dynamic_tool_error",
    terminalReason: params.terminalReason ?? "failed",
  });
}

/** Emits the terminal event matching a dynamic tool response's diagnostic type. */
export function emitDynamicToolTerminalDiagnostic(
  params: DynamicToolDiagnosticContext & {
    response: CodexDynamicToolRuntimeResponse;
    durationMs: number;
  },
): void {
  const terminalType =
    params.response.diagnosticTerminalType ?? (params.response.success ? "completed" : "error");
  if (terminalType === "completed") {
    emitTrustedDiagnosticEvent({
      type: "tool.execution.completed",
      ...diagnosticToolIdentity(params),
      durationMs: params.durationMs,
    });
    return;
  }
  if (terminalType === "blocked") {
    emitTrustedDiagnosticEvent({
      type: "tool.execution.blocked",
      ...diagnosticToolIdentity(params),
      deniedReason: "plugin-before-tool-call",
      reason: "Tool call blocked",
    });
    return;
  }
  emitDynamicToolErrorDiagnostic({
    ...params,
    terminalReason: params.response.diagnosticTerminalReason ?? "failed",
  });
}
