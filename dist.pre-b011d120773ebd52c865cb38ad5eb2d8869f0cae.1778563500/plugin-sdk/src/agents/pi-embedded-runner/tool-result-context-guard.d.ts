import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ContextEngine, ContextEngineRuntimeContext } from "../../context-engine/types.js";
import { CONTEXT_LIMIT_TRUNCATION_NOTICE, formatContextLimitTruncationNotice } from "./context-truncation-notice.js";
import { type MidTurnPrecheckRequest } from "./run/midturn-precheck.js";
export declare const PREEMPTIVE_CONTEXT_OVERFLOW_MESSAGE = "Context overflow: estimated context size exceeds safe threshold during tool loop.";
type GuardableAgent = object;
type MidTurnPrecheckOptions = {
    enabled?: boolean;
    contextTokenBudget: number;
    reserveTokens: () => number;
    toolResultMaxChars?: number;
    getSystemPrompt?: () => string | undefined;
    getPrePromptMessageCount?: () => number;
    onMidTurnPrecheck?: (request: MidTurnPrecheckRequest) => void;
};
export { CONTEXT_LIMIT_TRUNCATION_NOTICE, formatContextLimitTruncationNotice };
/**
 * Per-iteration `afterTurn` + `assemble` wrapper for sessions where
 * the context engine owns compaction. Lets the engine compact inside
 * a long tool loop instead of only at end of attempt.
 */
export declare function installContextEngineLoopHook(params: {
    agent: GuardableAgent;
    contextEngine: ContextEngine;
    sessionId: string;
    sessionKey?: string;
    sessionFile: string;
    tokenBudget?: number;
    modelId: string;
    getPrePromptMessageCount?: () => number;
    getRuntimeContext?: (params: {
        messages: AgentMessage[];
        prePromptMessageCount: number;
    }) => ContextEngineRuntimeContext | undefined;
}): () => void;
export declare function installToolResultContextGuard(params: {
    agent: GuardableAgent;
    contextWindowTokens: number;
    midTurnPrecheck?: MidTurnPrecheckOptions;
}): () => void;
