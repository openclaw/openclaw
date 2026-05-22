import type { PreemptiveCompactionRoute } from "./preemptive-compaction.types.js";
export type MidTurnPrecheckRequest = {
    route: Exclude<PreemptiveCompactionRoute, "fits">;
    estimatedPromptTokens: number;
    promptBudgetBeforeReserve: number;
    overflowTokens: number;
    toolResultReducibleChars: number;
    effectiveReserveTokens: number;
};
export declare const MID_TURN_PRECHECK_ERROR_MESSAGE = "Context overflow: prompt too large for the model (mid-turn precheck).";
export declare class MidTurnPrecheckSignal extends Error {
    readonly request: MidTurnPrecheckRequest;
    constructor(request: MidTurnPrecheckRequest);
}
export declare function isMidTurnPrecheckSignal(error: unknown): error is MidTurnPrecheckSignal;
