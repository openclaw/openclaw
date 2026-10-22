import type { ResponsesInputItem, StreamEvent } from "./mock-openai-contracts.js";
import { planCronBlockedOutcomeTurn } from "./mock-openai-cron-blocked-outcome.js";
import { planCronFailureRepairTurn } from "./mock-openai-cron-failure-repair.js";
import { planCronRecoveredToolErrorTurn } from "./mock-openai-cron-recovered-tool-error.js";
import { planCronSendContinueTurn } from "./mock-openai-cron-send-continue.js";

/** Scripted turns for the scheduled-job QA scenarios, in dispatch priority order. */
export function planCronScenarioTurn(params: {
  prompt: string;
  input: ResponsesInputItem[];
  body: Record<string, unknown>;
  buildToolCall: (name: string, args: Record<string, unknown>) => StreamEvent[];
}): StreamEvent[] | null {
  return (
    planCronFailureRepairTurn(params.prompt, params.input) ??
    planCronSendContinueTurn(params) ??
    planCronRecoveredToolErrorTurn(params) ??
    planCronBlockedOutcomeTurn(params.prompt)
  );
}
