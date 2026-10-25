import type { ResponsesInputItem, StreamEvent } from "./mock-openai-contracts.js";
import { buildAssistantEvents } from "./mock-openai-events.js";

const QA_CRON_PARENT_WAKE_CHECK_RE = /Cron parent wake QA check: marker=([a-z0-9-]{1,40})/;
const QA_CRON_PARENT_WAKE_EVENT_RE = /Cron parent wake QA event: marker=([a-z0-9-]{1,40})/;
const QA_CRON_PARENT_WAKE_DONE = "QA-CRON-PARENT-WAKE-DONE";

/**
 * Scripts both sides of a scheduled child's parent wake. The scheduled turn
 * calls `automations wake` once, then reports. The woken conversation's turn
 * acknowledges the event with its marker, which the scenario observes.
 */
export function planCronParentWakeTurn(params: {
  prompt: string;
  input: ResponsesInputItem[];
  buildToolCall: (name: string, args: Record<string, unknown>) => StreamEvent[];
}): StreamEvent[] | null {
  const checkMarker = QA_CRON_PARENT_WAKE_CHECK_RE.exec(params.prompt)?.[1];
  if (checkMarker) {
    return params.input.some((item) => item.type === "function_call_output")
      ? buildAssistantEvents(QA_CRON_PARENT_WAKE_DONE)
      : params.buildToolCall("automations", {
          action: "wake",
          text: `Cron parent wake QA event: marker=${checkMarker}`,
          mode: "now",
        });
  }
  const eventMarker = QA_CRON_PARENT_WAKE_EVENT_RE.exec(params.prompt)?.[1];
  return eventMarker ? buildAssistantEvents(`QA-CRON-PARENT-WAKE-ACK ${eventMarker}`) : null;
}
