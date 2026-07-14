import type { EmbeddedRunAttemptParams } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { CodexDynamicToolRuntimeResponse } from "./dynamic-tool-response-state.js";
import type { CodexAppServerEventProjector } from "./event-projector.js";
import type { CodexDynamicToolCallParams, CodexDynamicToolCallResponse } from "./protocol.js";

/** Project one OpenClaw dynamic-tool response with its executed mutation identity. */
export function recordCodexDynamicToolResult(
  projector: CodexAppServerEventProjector | undefined,
  call: CodexDynamicToolCallParams,
  response: CodexDynamicToolRuntimeResponse,
  protocolResponse: CodexDynamicToolCallResponse,
  toolMeta: string | undefined,
  toolMutationRuntime: EmbeddedRunAttemptParams["toolMutationRuntime"],
): void {
  const mutationState = toolMutationRuntime?.classify(
    call.tool,
    response.executedArguments ?? call.arguments,
    toolMeta,
  );
  projector?.recordDynamicToolResult({
    callId: call.callId,
    tool: call.tool,
    asyncStarted: response.asyncStarted === true,
    // Older bridge responses omit executionStarted; only explicit false proves
    // preparation stopped before the tool body, matching the standard runtime.
    executionStarted: response.executionStarted !== false,
    ...(mutationState ? { mutationState } : {}),
    success: protocolResponse.success,
    terminalType:
      response.diagnosticTerminalType ?? (protocolResponse.success ? "completed" : "error"),
    sideEffectEvidence: response.sideEffectEvidence === true,
    contentItems: protocolResponse.contentItems,
  });
}
