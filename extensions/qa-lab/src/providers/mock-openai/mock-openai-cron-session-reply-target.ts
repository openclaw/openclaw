import type { ResponsesInputItem, StreamEvent } from "./mock-openai-contracts.js";
import { buildAssistantEvents } from "./mock-openai-events.js";

const QA_CRON_SESSION_REPLY_TARGET_PROMPT_RE = /Session event reply-target QA check/i;
const QA_CRON_SESSION_REPLY_TARGET_RE = /Conversation target: (\S+)/;
const QA_CRON_SESSION_REPLY_TARGET_SENT_MARKER = "QA-SESSION-EVENT-REPLY-TARGET-SENT";

/**
 * Scripts a session-bound cron turn that posts to its own conversation with the message tool,
 * naming no `replyTo`, then ends silently. The send must not inherit the event's id as a reply.
 */
export function planCronSessionReplyTargetTurn(params: {
  prompt: string;
  input: ResponsesInputItem[];
  buildToolCall: (name: string, args: Record<string, unknown>) => StreamEvent[];
}): StreamEvent[] | null {
  if (!QA_CRON_SESSION_REPLY_TARGET_PROMPT_RE.test(params.prompt)) {
    return null;
  }
  const target = QA_CRON_SESSION_REPLY_TARGET_RE.exec(params.prompt)?.[1];
  if (params.input.at(-1)?.type !== "function_call_output" && target) {
    return params.buildToolCall("message", {
      action: "send",
      channel: "telegram",
      target,
      message: QA_CRON_SESSION_REPLY_TARGET_SENT_MARKER,
    });
  }
  return buildAssistantEvents("NO_REPLY");
}
