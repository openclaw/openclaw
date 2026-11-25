import {
  QA_GROUP_PROGRESS_THEN_EMPTY_PROMPT_RE,
  QA_GROUP_VISIBLE_REPLY_TOOL_PROMPT_RE,
  type StreamEvent,
} from "./mock-openai-contracts.js";
import { hasDeclaredTool } from "./mock-openai-directives.js";
import { buildAssistantEvents } from "./mock-openai-events.js";
import { buildToolCallEventsWithArgs } from "./mock-openai-tooling.js";

/**
 * Scripts group turns that reply through the message tool: a plain visible reply, and a
 * progress send followed by an empty stop.
 */
export function planGroupMessageToolTurn(params: {
  allInputText: string;
  body: Record<string, unknown>;
  marker: string | null;
  hasCompletedToolOutput: boolean;
  isSettledToolContinuation: boolean;
}): StreamEvent[] | null {
  const canSend = !params.hasCompletedToolOutput && hasDeclaredTool(params.body, "message");
  if (QA_GROUP_VISIBLE_REPLY_TOOL_PROMPT_RE.test(params.allInputText)) {
    const marker = params.marker ?? "QA-GROUP-TOOL-OK";
    return canSend
      ? buildToolCallEventsWithArgs("message", { action: "send", message: marker })
      : buildAssistantEvents("");
  }
  if (!QA_GROUP_PROGRESS_THEN_EMPTY_PROMPT_RE.test(params.allInputText)) {
    return null;
  }
  const marker = params.marker ?? "QA-GROUP-PROGRESS-OK";
  // A real model asked to finalize restates the progress it already sent.
  if (params.isSettledToolContinuation) {
    return buildAssistantEvents(`Still running, I will report back. ${marker}`);
  }
  return canSend
    ? buildToolCallEventsWithArgs("message", {
        action: "send",
        message: `Started the run, I will report back. ${marker}`,
        final: false,
      })
    : buildAssistantEvents("");
}
