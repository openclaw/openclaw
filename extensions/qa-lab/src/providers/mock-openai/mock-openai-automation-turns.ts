import type { ResponsesInputItem, StreamEvent } from "./mock-openai-contracts.js";
import { planCronBlockedOutcomeTurn } from "./mock-openai-cron-blocked-outcome.js";
import { planCronFailureRepairTurn } from "./mock-openai-cron-failure-repair.js";
import { planCronParentBoardTurn } from "./mock-openai-cron-parent-board.js";
import { planCronSendContinueTurn } from "./mock-openai-cron-send-continue.js";
import { planCronTrustedOwnerTurn } from "./mock-openai-cron-trusted-owner.js";
import { planHookAutomationsScopeTurn } from "./mock-openai-hook-automations-scope.js";
import { planOwnerCompletionTurn } from "./mock-openai-owner-completion.js";

/** Scripted cron and hook automation turns, checked in a fixed order. */
export function planAutomationScenarioTurn(params: {
  prompt: string;
  input: ResponsesInputItem[];
  body: Record<string, unknown>;
  buildToolCall: (name: string, args: Record<string, unknown>) => StreamEvent[];
}): StreamEvent[] | null {
  return (
    planCronFailureRepairTurn(params.prompt, params.input) ??
    planCronParentBoardTurn(params.prompt, params.input) ??
    planCronSendContinueTurn(params) ??
    planCronBlockedOutcomeTurn(params.prompt) ??
    planCronTrustedOwnerTurn(params) ??
    planHookAutomationsScopeTurn(params) ??
    planOwnerCompletionTurn(params)
  );
}
