import { isRecord } from "@openclaw/normalization-core";
import type { AgentToolResult } from "openclaw/plugin-sdk/agent-core";
import type { EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams } from "openclaw/plugin-sdk/agent-harness-runtime";
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
  /** Per-invocation provenance retained for OpenClaw's mirrored transcript only. */
  resultContentSource?: "network";
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
    contentItems: [{ type: "inputText", text: message }],
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

export function isToolResultYield(result: AgentToolResult<unknown>): boolean {
  const details = result.details;
  if (!isRecord(details) || typeof details.status !== "string") {
    return false;
  }
  return details.status.trim().toLowerCase() === "yielded";
}

export function isAsyncStartedToolResult(result: AgentToolResult<unknown>): boolean {
  const details = result.details;
  return isRecord(details) && details.async === true && details.status === "started";
}
