import type { AgentToolResult } from "openclaw/plugin-sdk/agent-core";
import type {
  captureToolAuthoredSourceReply,
  EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams,
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
  /** The call named no tool available to this turn. */
  unknownTool?: true;
  replaySafe?: boolean;
  sideEffectEvidence?: boolean;
  terminate?: boolean;
  /** Committed source delivery survives failed result presentation or siblings. */
  finalSourceReplyDelivered?: true;
  /** Candidate reply, committed only when the entire tool batch can complete. */
  toolAuthoredSourceReply?: ReturnType<typeof captureToolAuthoredSourceReply>;
  transcriptDetails?: unknown;
  terminalResolution?: ReturnType<NonNullable<EmbeddedRunAttemptParams["observeToolTerminal"]>>;
};

export function createFailedDynamicToolResponse(
  message: string,
  options?: {
    executedArguments?: Record<string, unknown>;
    executionStarted?: boolean;
    unknownTool?: true;
    sideEffectEvidence?: boolean;
    terminalReason?: CodexDynamicToolDiagnosticTerminalReason;
  },
): CodexDynamicToolRuntimeResponse {
  return {
    contentItems: [{ type: "inputText", text: message }],
    success: false,
    diagnosticTerminalReason: options?.terminalReason ?? "failed",
    diagnosticTerminalType: "error",
    // A call to a missing tool never starts.
    executionStarted: options?.unknownTool ? false : options?.executionStarted,
    executedArguments: options?.executedArguments,
    ...(options?.unknownTool ? { unknownTool: true as const } : {}),
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
