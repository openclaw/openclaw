import type { CodexAppServerEventProjector } from "./event-projector.js";
import type { CodexDynamicToolCallParams } from "./protocol.js";

/** Preserves a transport-confirmed final reply when native cleanup wins projection. */
export function recordCommittedFinalSourceReplyResult(
  projector: CodexAppServerEventProjector,
  call: CodexDynamicToolCallParams | undefined,
): void {
  if (!call) {
    return;
  }
  projector.recordDynamicToolResult({
    callId: call.callId,
    tool: call.tool,
    success: true,
    terminalType: "completed",
    sideEffectEvidence: true,
    contentItems: [],
  });
}
