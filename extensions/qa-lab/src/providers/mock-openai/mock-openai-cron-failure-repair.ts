import type { ResponsesInputItem, StreamEvent } from "./mock-openai-contracts.js";
import { buildAssistantEvents, buildFailedResponseEvents } from "./mock-openai-events.js";
import { buildToolCallEventsWithArgs } from "./mock-openai-tooling.js";

const QA_CRON_REPAIR_PROMPT_RE = /Cron failure repair QA check/i;
const QA_CRON_REPAIR_BROKEN_RE = /Cron failure repair QA check: broken step/i;
const QA_CRON_REPAIR_BRIEF_RE =
  /Automation repair request from the scheduler[\s\S]*?created in this conversation, failed \d+ consecutive runs/;
const QA_CRON_REPAIR_OWNER_MARKER = "QA-CRON-REPAIR-OWNER-READY";
const QA_CRON_REPAIR_FIXED_MARKER = "QA-CRON-REPAIR-FIXED";
const QA_CRON_REPAIR_STEP_FILE = "cron-repair-step.md";
const QA_CRON_REPAIR_FIXED_STEP = "Sync step fixed by the owner conversation.\n";

/**
 * Scripts the cron failure-repair QA flow: the job's broken step fails its turn, and the
 * owner conversation, which receives the scheduler's repair request as an ordinary turn, fixes
 * the workspace step file the job follows with its ordinary tools and reports the fix.
 */
export function planCronFailureRepairTurn(
  prompt: string,
  input: ResponsesInputItem[],
): StreamEvent[] | null {
  if (!QA_CRON_REPAIR_PROMPT_RE.test(prompt)) {
    return null;
  }
  if (!QA_CRON_REPAIR_BRIEF_RE.test(prompt)) {
    if (QA_CRON_REPAIR_BROKEN_RE.test(prompt)) {
      return buildFailedResponseEvents();
    }
    return buildAssistantEvents(QA_CRON_REPAIR_OWNER_MARKER);
  }
  const wrote = input.some((item) => item.type === "function_call_output");
  return wrote
    ? buildAssistantEvents(`Fixed the sync step file. ${QA_CRON_REPAIR_FIXED_MARKER}`)
    : buildToolCallEventsWithArgs("write", {
        path: QA_CRON_REPAIR_STEP_FILE,
        content: QA_CRON_REPAIR_FIXED_STEP,
      });
}
