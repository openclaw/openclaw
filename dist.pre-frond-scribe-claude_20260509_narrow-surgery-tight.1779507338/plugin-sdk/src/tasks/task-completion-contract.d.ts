import type { TaskTerminalOutcome } from "./task-registry.types.js";
export type RequiredCompletionTerminalResult = {
    terminalOutcome?: Extract<TaskTerminalOutcome, "blocked">;
    terminalSummary?: string;
};
export declare function isProgressOnlyCompletionText(value: string | null | undefined): boolean;
export declare function resolveRequiredCompletionTerminalResult(resultText: string | null | undefined): RequiredCompletionTerminalResult;
export declare function resolveRequiredCompletionDeliveryFailureTerminalResult(reason: string | null | undefined): RequiredCompletionTerminalResult;
