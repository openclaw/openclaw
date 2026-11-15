import type { ResponsesInputItem, StreamEvent } from "./mock-openai-contracts.js";
import { hasToolDefinition } from "./mock-openai-directives.js";
import { buildAssistantEvents } from "./mock-openai-events.js";

const QA_CRON_SEND_CONTINUE_PROMPT_RE = /Cron send-then-continue QA check/i;
const QA_CRON_SEND_CONTINUE_TARGET_RE = /Delivery target: (\S+)/;
const QA_CRON_SEND_CONTINUE_SENT_MARKER = "QA-CRON-SEND-CONTINUE-SENT";
const QA_CRON_SEND_CONTINUE_DONE_MARKER = "QA-CRON-SEND-CONTINUE-DONE";
const QA_CRON_SEND_CONTINUE_FILE = "cron-send-continue-marker.txt";

/**
 * Scripts a cron job that delivers to its own target and then has more work: send with
 * `final` omitted, record the send in a workspace file, then finish. The file write only
 * happens when the runtime keeps the turn open after the confirmed send.
 */
export function planCronSendContinueTurn(params: {
  prompt: string;
  input: ResponsesInputItem[];
  body: Record<string, unknown>;
  buildToolCall: (name: string, args: Record<string, unknown>) => StreamEvent[];
}): StreamEvent[] | null {
  if (!QA_CRON_SEND_CONTINUE_PROMPT_RE.test(params.prompt)) {
    return null;
  }
  const target = QA_CRON_SEND_CONTINUE_TARGET_RE.exec(params.prompt)?.[1];
  const completed = params.input.filter((item) => item.type === "function_call_output").length;
  if (completed === 0 && target) {
    return params.buildToolCall("message", {
      action: "send",
      channel: "qa-channel",
      target,
      message: QA_CRON_SEND_CONTINUE_SENT_MARKER,
    });
  }
  if (completed === 1) {
    const content = `sent ${QA_CRON_SEND_CONTINUE_SENT_MARKER}\n`;
    // Codex keeps file and shell tools native; the embedded runtime uses OpenClaw's write.
    return hasToolDefinition(params.body, "exec_command")
      ? params.buildToolCall("exec_command", {
          cmd: `printf '${content.replace("\n", "\\n")}' > ${QA_CRON_SEND_CONTINUE_FILE}`,
        })
      : params.buildToolCall("write", { path: QA_CRON_SEND_CONTINUE_FILE, content });
  }
  // Announce delivery must stay skipped after the send, so this text never posts.
  return buildAssistantEvents(QA_CRON_SEND_CONTINUE_DONE_MARKER);
}
