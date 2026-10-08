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

export function createCodexDynamicToolDiagnostics(params: DynamicToolDiagnosticContext) {
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
