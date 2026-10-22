import type { ResponsesInputItem, StreamEvent } from "./mock-openai-contracts.js";
import { hasToolDefinition } from "./mock-openai-directives.js";
import { buildAssistantEvents } from "./mock-openai-events.js";

const QA_CRON_RECOVERED_PROMPT_RE = /Cron recovered tool error QA check/i;
export const QA_CRON_RECOVERED_MISSING_FILE = "qa-cron-recovered-missing-input.txt";

/**
 * Scripts a scheduled turn whose read fails, after which the model decides there is
 * nothing to report and ends with NO_REPLY. The run must stay successful and silent.
 */
export function planCronRecoveredToolErrorTurn(params: {
  prompt: string;
  input: ResponsesInputItem[];
  body: Record<string, unknown>;
  buildToolCall: (name: string, args: Record<string, unknown>) => StreamEvent[];
}): StreamEvent[] | null {
  if (!QA_CRON_RECOVERED_PROMPT_RE.test(params.prompt)) {
    return null;
  }
  const completed = params.input.filter((item) => item.type === "function_call_output").length;
  if (completed === 0) {
    // Codex keeps file tools native; the embedded runtime uses OpenClaw's read.
    return hasToolDefinition(params.body, "exec_command")
      ? params.buildToolCall("exec_command", { cmd: `cat ${QA_CRON_RECOVERED_MISSING_FILE}` })
      : params.buildToolCall("read", { path: QA_CRON_RECOVERED_MISSING_FILE });
  }
  return buildAssistantEvents("NO_REPLY");
}
