import type { ResponsesInputItem, StreamEvent } from "./mock-openai-contracts.js";
import { buildAssistantEvents } from "./mock-openai-events.js";
import { extractToolOutput } from "./mock-openai-input.js";

const QA_CRON_SELF_SCRATCH_PROMPT_RE =
  /Automation self scratch QA check: content=(\S+) marker=(\S+)/;

/**
 * Scripts a scheduled run that reads its own scratch, replaces it at the revision it read,
 * then ends with the marker. The scenario asserts the stored scratch afterwards.
 */
export function planCronSelfScratchTurn(params: {
  prompt: string;
  input: ResponsesInputItem[];
  buildToolCall: (name: string, args: Record<string, unknown>) => StreamEvent[];
}): StreamEvent[] | null {
  const match = QA_CRON_SELF_SCRATCH_PROMPT_RE.exec(params.prompt);
  if (!match) {
    return null;
  }
  const [, content, marker] = match;
  const completed = params.input.filter((item) => item.type === "function_call_output").length;
  if (completed === 0) {
    return params.buildToolCall("automations", { action: "scratch_get" });
  }
  // The tool result arrives wrapped and JSON-escaped, so read the revision from the text.
  const revision = /currentRevision\\?":(\d+)/.exec(extractToolOutput(params.input))?.[1];
  if (completed === 1 && revision !== undefined) {
    return params.buildToolCall("automations", {
      action: "scratch_set",
      content,
      expectedRevision: Number(revision),
    });
  }
  return buildAssistantEvents(marker ?? "");
}
