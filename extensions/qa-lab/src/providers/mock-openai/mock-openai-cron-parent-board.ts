import type { ResponsesInputItem, StreamEvent } from "./mock-openai-contracts.js";
import { buildAssistantEvents } from "./mock-openai-events.js";
import { buildToolCallEventsWithArgs } from "./mock-openai-tooling.js";

const QA_CRON_PARENT_BOARD_PROMPT_RE = /Cron parent board QA check: tab=([a-z0-9-]{1,40})/;
const QA_CRON_PARENT_BOARD_DONE = "QA-CRON-PARENT-BOARD-DONE";

/**
 * Scripts a scheduled turn that authors its board: it creates one dashboard tab,
 * then reports. The scenario checks which session's board received the tab.
 */
export function planCronParentBoardTurn(
  prompt: string,
  input: ResponsesInputItem[],
): StreamEvent[] | null {
  const tabId = QA_CRON_PARENT_BOARD_PROMPT_RE.exec(prompt)?.[1];
  if (!tabId) {
    return null;
  }
  return input.some((item) => item.type === "function_call_output")
    ? buildAssistantEvents(QA_CRON_PARENT_BOARD_DONE)
    : buildToolCallEventsWithArgs("dashboard", {
        action: "tab_create",
        tabId,
        title: "Scheduled report",
      });
}
