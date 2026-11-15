import {
  isCronExecutionInputProvenance,
  isProgressCardRefreshInputProvenance,
  isSubagentCoordinationInputProvenance,
  normalizeInputProvenance,
  type InputProvenance,
} from "../../sessions/input-provenance.js";
import type { AgentMessage } from "../runtime/index.js";

/**
 * Keep internal messages in the audit/model transcript without
 * projecting them into user-facing chat history.
 */
export function projectAgentHarnessTranscriptMessageForDisplay<T extends AgentMessage>(params: {
  hidden: boolean;
  inputProvenance?: InputProvenance;
  runId?: string;
  message: T;
}): T {
  const inputProvenance =
    params.message.role === "user"
      ? (normalizeInputProvenance(Reflect.get(params.message, "provenance")) ??
        params.inputProvenance)
      : params.inputProvenance;
  const scheduled = isCronExecutionInputProvenance(inputProvenance);
  const toolCall =
    params.message.role === "assistant" &&
    params.message.content.some((block) => block.type === "toolCall");
  // Cron final delivery mirrors meaningful output; keep execution prose audit-only.
  const scheduledAssistant =
    params.message.role === "assistant" &&
    params.message.stopReason !== "error" &&
    params.message.stopReason !== "aborted";
  const executionOnly =
    scheduled &&
    (params.message.role === "user" ||
      toolCall ||
      (params.message.role === "toolResult" && !params.message.isError) ||
      scheduledAssistant);
  if (
    !params.hidden &&
    !isSubagentCoordinationInputProvenance(inputProvenance) &&
    !isProgressCardRefreshInputProvenance(inputProvenance) &&
    !executionOnly
  ) {
    return params.message;
  }
  if (Reflect.get(params.message, "display") === false) {
    return params.message;
  }
  return Object.assign({}, params.message, { display: false });
}
