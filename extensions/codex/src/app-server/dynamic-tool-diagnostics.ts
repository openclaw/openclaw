import {
  emitTrustedDiagnosticEvent,
  hasPendingInternalDiagnosticEvent,
  type DiagnosticEventPayload,
} from "openclaw/plugin-sdk/diagnostic-runtime";
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

export function createCodexDynamicToolDiagnostics(params: DynamicToolDiagnosticContext) {
  const matchesTerminal = (event: DiagnosticEventPayload): boolean => {
    if (
      (event.type !== "tool.execution.completed" &&
        event.type !== "tool.execution.error" &&
        event.type !== "tool.execution.blocked") ||
      event.toolCallId !== params.call.callId ||
      event.toolName !== params.call.tool
    ) {
      return false;
    }
    if (params.runId !== undefined) {
      return event.runId === params.runId;
    }
    if (params.sessionId !== undefined) {
      return event.sessionId === params.sessionId;
    }
    if (params.sessionKey !== undefined) {
      return event.sessionKey === params.sessionKey;
    }
    return (
      event.runId === undefined && event.sessionId === undefined && event.sessionKey === undefined
    );
  };
  const error = (
    durationMs: number,
    terminalReason: "failed" | "cancelled" | "timed_out" = "failed",
  ) => {
    emitTrustedDiagnosticEvent({
      type: "tool.execution.error",
      ...diagnosticToolIdentity(params),
      durationMs,
      errorCategory: "codex_dynamic_tool_error",
      terminalReason,
    });
  };
  return {
    matchesTerminal,
    hasPendingTerminal: () => hasPendingInternalDiagnosticEvent(matchesTerminal),
    started() {
      emitTrustedDiagnosticEvent({
        type: "tool.execution.started",
        ...diagnosticToolIdentity(params),
      });
    },
    error,
    terminal(response: CodexDynamicToolRuntimeResponse, durationMs: number) {
      const type = response.diagnosticTerminalType ?? (response.success ? "completed" : "error");
      if (type === "completed") {
        emitTrustedDiagnosticEvent({
          type: "tool.execution.completed",
          ...diagnosticToolIdentity(params),
          durationMs,
        });
      } else if (type === "blocked") {
        emitTrustedDiagnosticEvent({
          type: "tool.execution.blocked",
          ...diagnosticToolIdentity(params),
          deniedReason: "plugin-before-tool-call",
          reason: "Tool call blocked",
        });
      } else {
        error(durationMs, response.diagnosticTerminalReason ?? "failed");
      }
    },
  };
}
