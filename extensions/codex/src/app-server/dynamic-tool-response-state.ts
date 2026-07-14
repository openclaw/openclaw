import type { EmbeddedRunAttemptParams } from "openclaw/plugin-sdk/agent-harness-runtime";
import type {
  CodexDynamicToolCallResponse,
  CodexDynamicToolDiagnosticTerminalReason,
} from "./protocol.js";

type ToolExecutionContext = {
  runId?: string;
  toolExecutionRuntime?: EmbeddedRunAttemptParams["toolExecutionRuntime"];
};

export function readDynamicToolExecutionStarted(
  context: ToolExecutionContext | undefined,
  toolCallId: string,
  fallback: boolean,
): boolean {
  return context?.toolExecutionRuntime?.peekStarted(toolCallId, context.runId) ?? fallback;
}

export function readDynamicToolExecutedArguments(
  context: ToolExecutionContext | undefined,
  toolCallId: string,
): Record<string, unknown> | undefined {
  const value = context?.toolExecutionRuntime?.peekArguments(toolCallId, context.runId);
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function readDynamicToolExecutionState(
  context: ToolExecutionContext | undefined,
  toolCallId: string,
  fallback: boolean,
) {
  return {
    executedArguments: readDynamicToolExecutedArguments(context, toolCallId),
    executionStarted: readDynamicToolExecutionStarted(context, toolCallId, fallback),
  };
}

/** OpenClaw-only dynamic-tool facts that never cross into the Codex protocol. */
export type CodexDynamicToolRuntimeResponse = CodexDynamicToolCallResponse & {
  executionStarted?: boolean;
  executedArguments?: Record<string, unknown>;
};

export function withDynamicToolExecutionState<T extends CodexDynamicToolRuntimeResponse>(
  response: T,
  state: {
    executedArguments: Record<string, unknown>;
    executionStarted: boolean;
    sideEffectEvidence?: boolean;
  },
): T {
  // Keep post-hook arguments non-enumerable so only OpenClaw terminal-outcome
  // bookkeeping sees them; Codex receives contentItems + success.
  Object.defineProperties(response, {
    executedArguments: {
      configurable: true,
      enumerable: false,
      value: state.executedArguments,
    },
    executionStarted: {
      configurable: true,
      enumerable: false,
      value: state.executionStarted,
    },
  });
  return withDynamicToolSideEffectEvidence(response, state.sideEffectEvidence === true);
}

export function withDynamicToolSideEffectEvidence<T extends CodexDynamicToolRuntimeResponse>(
  response: T,
  sideEffectEvidence: boolean,
): T {
  if (sideEffectEvidence) {
    Object.defineProperty(response, "sideEffectEvidence", {
      configurable: true,
      enumerable: false,
      value: true,
    });
  }
  return response;
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
  const response: CodexDynamicToolRuntimeResponse = {
    contentItems: [{ type: "inputText", text: message }],
    success: false,
  };
  Object.defineProperties(response, {
    diagnosticTerminalReason: {
      configurable: true,
      enumerable: false,
      value: options?.terminalReason ?? "failed",
    },
    diagnosticTerminalType: {
      configurable: true,
      enumerable: false,
      value: "error",
    },
  });
  if (options?.executionStarted !== undefined) {
    Object.defineProperty(response, "executionStarted", {
      configurable: true,
      enumerable: false,
      value: options.executionStarted,
    });
  }
  if (options?.executedArguments !== undefined) {
    Object.defineProperty(response, "executedArguments", {
      configurable: true,
      enumerable: false,
      value: options.executedArguments,
    });
  }
  return withDynamicToolSideEffectEvidence(response, options?.sideEffectEvidence === true);
}
