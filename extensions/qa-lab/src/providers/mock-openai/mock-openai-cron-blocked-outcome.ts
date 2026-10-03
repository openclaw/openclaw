import type { StreamEvent } from "./mock-openai-contracts.js";
import { buildAssistantEvents } from "./mock-openai-events.js";

const QA_CRON_BLOCKED_PROMPT_RE = /Cron blocked outcome QA check: case=(\w+)/;
const QA_CRON_BLOCKED_REASON = "Unable to run the report: this run has no shell tool.";

/**
 * Scripts the cron blocked-outcome QA flow: a scheduled turn that cannot do its task reports
 * the failure on its first line, a turn that merely quotes the token and an intentionally
 * quiet turn stay successful.
 */
export function planCronBlockedOutcomeTurn(prompt: string): StreamEvent[] | null {
  const testCase = QA_CRON_BLOCKED_PROMPT_RE.exec(prompt)?.[1];
  if (!testCase) {
    return null;
  }
  if (testCase === "silent") {
    return buildAssistantEvents("NO_REPLY");
  }
  if (testCase === "quoted") {
    return buildAssistantEvents(
      "Report posted. AUTOMATION_FAILED would only lead this reply if the report were blocked.",
    );
  }
  return buildAssistantEvents(`AUTOMATION_FAILED\n${QA_CRON_BLOCKED_REASON}`);
}
