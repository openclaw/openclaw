import type { AgentToolResult } from "openclaw/plugin-sdk/agent-core";
import {
  type EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams,
  sanitizeToolResult,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import type {
  CodexDynamicToolCallResponse,
  CodexDynamicToolDiagnosticTerminalReason,
  CodexDynamicToolDiagnosticTerminalType,
} from "./protocol.js";

/** OpenClaw-only dynamic-tool facts that never cross into the Codex protocol. */
export type CodexDynamicToolRuntimeResponse = CodexDynamicToolCallResponse & {
  asyncStarted?: boolean;
  diagnosticTerminalReason?: CodexDynamicToolDiagnosticTerminalReason;
  diagnosticTerminalType?: CodexDynamicToolDiagnosticTerminalType;
  executionStarted?: boolean;
  executedArguments?: Record<string, unknown>;
  replaySafe?: boolean;
  sideEffectEvidence?: boolean;
  terminate?: boolean;
  transcriptDetails?: unknown;
  terminalResolution?: ReturnType<NonNullable<EmbeddedRunAttemptParams["observeToolTerminal"]>>;
};

export function createFailedDynamicToolResponse(
  message: string,
  options?: {
    executedArguments?: Record<string, unknown>;
    executionStarted?: boolean;
    sideEffectEvidence?: boolean;
    terminalReason?: CodexDynamicToolDiagnosticTerminalReason;
  },
): CodexDynamicToolRuntimeResponse {
  return {
    contentItems: [{ type: "inputText", text: sanitizeToolResult(message) }],
    success: false,
    diagnosticTerminalReason: options?.terminalReason ?? "failed",
    diagnosticTerminalType: "error",
    executionStarted: options?.executionStarted,
    executedArguments: options?.executedArguments,
    sideEffectEvidence: options?.sideEffectEvidence === true || undefined,
  };
}

export function failedToolResult(
  message: string,
  status: "blocked" | CodexDynamicToolDiagnosticTerminalReason = "failed",
): AgentToolResult<unknown> {
  return {
    content: [{ type: "text", text: message }],
    details: { status, error: message },
  };
}
