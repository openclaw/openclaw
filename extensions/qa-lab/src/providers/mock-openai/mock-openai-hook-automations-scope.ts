import type { ResponsesInputItem, StreamEvent } from "./mock-openai-contracts.js";
import { buildAssistantEvents } from "./mock-openai-events.js";

const QA_HOOK_AUTOMATIONS_SCOPE_PROMPT_RE = /Hook automations scope QA check: target=(\S+)/;
const QA_HOOK_AUTOMATIONS_SCOPE_DONE_MARKER = "QA-HOOK-AUTOMATIONS-SCOPE-DONE";

/**
 * Scripts a webhook turn that asks the automations tool to remove another job,
 * then lists automations as an allowed control, then finishes. The scenario
 * asserts both tool results and the other job's survival.
 */
export function planHookAutomationsScopeTurn(params: {
  prompt: string;
  input: ResponsesInputItem[];
  buildToolCall: (name: string, args: Record<string, unknown>) => StreamEvent[];
}): StreamEvent[] | null {
  const target = QA_HOOK_AUTOMATIONS_SCOPE_PROMPT_RE.exec(params.prompt)?.[1];
  if (!target) {
    return null;
  }
  const completed = params.input.filter((item) => item.type === "function_call_output").length;
  // Deferred catalogs route these through dispatch_action.
  if (completed === 0) {
    return params.buildToolCall("automations", { action: "remove", jobId: target });
  }
  if (completed === 1) {
    return params.buildToolCall("automations", { action: "list", includeDisabled: true });
  }
  return buildAssistantEvents(QA_HOOK_AUTOMATIONS_SCOPE_DONE_MARKER);
}
