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
  executionStarted?: boolean;
  executedArguments?: Record<string, unknown>;
  replaySafe?: boolean;
  sideEffectEvidence?: boolean;
  terminate?: boolean;
  transcriptDetails?: unknown;
  terminalResolution?: ReturnType<NonNullable<EmbeddedRunAttemptParams["observeToolTerminal"]>>;
};

export type SynchronousCoreFileReceipt = Readonly<{
  tool: string;
  argumentsJson: string;
  contentJson: string;
}>;
const synchronousCoreFileResults = new WeakMap<
  CodexDynamicToolRuntimeResponse,
  SynchronousCoreFileReceipt
>();

/** Private instance provenance; tool text or a serialized response cannot assert it. */
export function markSynchronousCoreFileResult(
  response: CodexDynamicToolRuntimeResponse,
  receipt: SynchronousCoreFileReceipt,
): void {
  synchronousCoreFileResults.set(response, receipt);
}

export function isSynchronousCoreFileResult(response: CodexDynamicToolRuntimeResponse): boolean {
  return synchronousCoreFileResults.has(response);
}

export function readSynchronousCoreFileReceipt(
  response: CodexDynamicToolRuntimeResponse,
): SynchronousCoreFileReceipt | undefined {
  return synchronousCoreFileResults.get(response);
}

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
