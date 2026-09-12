import { isExecToolName } from "./embedded-agent-subscribe.handlers.tools.start.js";
import type { EmbeddedAgentSubscribeContext } from "./embedded-agent-subscribe.handlers.types.js";
import {
  capLiveExecResult,
  sanitizeToolArgs,
  sanitizeToolResult,
} from "./embedded-agent-tool-results.js";
import type { AgentSessionEvent } from "./sessions/index.js";
import { normalizeToolPolicyName } from "./tool-policy.js";
import { isToolResultError } from "./tool-result-error.js";

export function recordEmbeddedToolTrajectoryEvent(
  ctx: Pick<EmbeddedAgentSubscribeContext, "params" | "log">,
  event: AgentSessionEvent,
): void {
  const recorder = ctx.params.trajectoryRecorder;
  if (!recorder) {
    return;
  }
  try {
    if (event.type === "tool_execution_start") {
      recorder.recordEvent("tool.call", {
        toolCallId: event.toolCallId,
        name: normalizeToolPolicyName(event.toolName),
        args: sanitizeToolArgs(event.args),
      });
    } else if (event.type === "tool_execution_end") {
      const name = normalizeToolPolicyName(event.toolName);
      const result = sanitizeToolResult(event.result);
      recorder.recordEvent("tool.result", {
        toolCallId: event.toolCallId,
        name,
        success: !(event.isError || isToolResultError(event.result)),
        result: isExecToolName(name) ? capLiveExecResult(result) : result,
      });
    }
  } catch (error) {
    // Optional capture must retain the queued handlers' failure containment.
    ctx.log.debug(`tool trajectory capture failed: ${String(error)}`);
  }
}
