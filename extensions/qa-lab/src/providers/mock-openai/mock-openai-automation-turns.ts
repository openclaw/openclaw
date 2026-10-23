import type { ResponsesInputItem, StreamEvent } from "./mock-openai-contracts.js";
import { planCronBlockedOutcomeTurn } from "./mock-openai-cron-blocked-outcome.js";
import { planCronFailureRepairTurn } from "./mock-openai-cron-failure-repair.js";
import { planCronSendContinueTurn } from "./mock-openai-cron-send-continue.js";
import { planHookAutomationsScopeTurn } from "./mock-openai-hook-automations-scope.js";

/** Scripted cron and hook automation turns, checked in a fixed order. */
export function planAutomationScenarioTurn(params: {
  prompt: string;
  input: ResponsesInputItem[];
  body: Record<string, unknown>;
  buildToolCall: (name: string, args: Record<string, unknown>) => StreamEvent[];
}): StreamEvent[] | null {
  return (
    planCronFailureRepairTurn(params.prompt, params.input) ??
    planCronSendContinueTurn(params) ??
    planCronBlockedOutcomeTurn(params.prompt) ??
    planHookAutomationsScopeTurn(params)
  );
}
