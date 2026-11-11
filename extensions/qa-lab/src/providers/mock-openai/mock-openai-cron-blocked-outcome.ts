import type { StreamEvent } from "./mock-openai-contracts.js";
import { buildAssistantEvents } from "./mock-openai-events.js";

const QA_CRON_BLOCKED_PROMPT_RE = /Cron blocked outcome QA check: case=(\w+)/;
const QA_CRON_BLOCKED_REASON = "Unable to run the report: this run has no shell tool.";

/**
 * Scripts a completed scheduled turn that reports a task blocker in ordinary prose,
 * plus an intentionally quiet turn. Neither reply is a runtime execution failure.
 */
export function planCronBlockedOutcomeTurn(prompt: string): StreamEvent[] | null {
  const testCase = QA_CRON_BLOCKED_PROMPT_RE.exec(prompt)?.[1];
  if (!testCase) {
    return null;
  }
  if (testCase === "silent") {
    return buildAssistantEvents("NO_REPLY");
  }
  return buildAssistantEvents(QA_CRON_BLOCKED_REASON);
}
