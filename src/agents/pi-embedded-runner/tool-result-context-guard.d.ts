import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ContextEngine, ContextEngineRuntimeContext } from "../../context-engine/types.js";
export declare const CONTEXT_LIMIT_TRUNCATION_NOTICE = "more characters truncated";
export declare const PREEMPTIVE_CONTEXT_OVERFLOW_MESSAGE = "Context overflow: estimated context size exceeds safe threshold during tool loop.";
type GuardableAgent = object;
export declare function formatContextLimitTruncationNotice(truncatedChars: number): string;
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
}): () => void;
export {};
