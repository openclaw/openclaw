import { isRecord } from "@openclaw/normalization-core/record-coerce";
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
  const shouldHide =
    params.hidden ||
    isSubagentCoordinationInputProvenance(inputProvenance) ||
    isProgressCardRefreshInputProvenance(inputProvenance) ||
    executionOnly;
  let projected = params.message;
  if (shouldHide) {
    if (Reflect.get(params.message, "display") === false) {
      return params.message;
    }
    projected = Object.assign({}, params.message, { display: false });
  }
  if (
    !shouldHide &&
    params.message.role === "assistant" &&
    Reflect.get(params.message, "display") !== false &&
    params.runId &&
    inputProvenance?.kind === "internal_system" &&
    inputProvenance.sourceTool === "exec" &&
    inputProvenance.runId &&
    inputProvenance.execCompletion?.status === "completed" &&
    inputProvenance.execCompletion.exitCode === 0
  ) {
    const metadata = Reflect.get(params.message, "__openclaw");
    projected = Object.assign({}, params.message, {
      __openclaw: {
        ...(isRecord(metadata) ? metadata : {}),
        execCompletion: {
          sourceRunId: inputProvenance.runId,
          ...inputProvenance.execCompletion,
        },
      },
    });
  }
  return projected;
}
