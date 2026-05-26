import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { PreemptiveCompactionRoute } from "./preemptive-compaction.types.js";
export declare const PREEMPTIVE_OVERFLOW_ERROR_TEXT = "Context overflow: prompt too large for the model (precheck).";
export type { PreemptiveCompactionRoute } from "./preemptive-compaction.types.js";
export type PreemptiveCompactionDecision = {
    route: PreemptiveCompactionRoute;
    shouldCompact: boolean;
    estimatedPromptTokens: number;
    pressureSource?: string;
    promptBudgetBeforeReserve: number;
    overflowTokens: number;
    toolResultReducibleChars: number;
    effectiveReserveTokens: number;
};
export type LlmBoundaryTokenPressure = {
    estimatedPromptTokens: number;
    source: string;
    renderedChars?: number;
};
export declare function estimateLlmBoundaryTokenPressure(params: {
    messages: AgentMessage[];
    systemPrompt?: string;
    prompt: string;
}): number;
export declare function estimateRenderedLlmBoundaryTokenPressure(params: {
    systemPrompt?: string;
    prompt: string;
}): number;
export declare function estimatePrePromptTokens(params: {
    messages: AgentMessage[];
    systemPrompt?: string;
    prompt: string;
}): number;
export declare function shouldPreemptivelyCompactBeforePrompt(params: {
    messages: AgentMessage[];
    unwindowedMessages?: AgentMessage[];
    systemPrompt?: string;
    prompt: string;
    contextTokenBudget: number;
    reserveTokens: number;
    toolResultMaxChars?: number;
    llmBoundaryTokenPressure?: LlmBoundaryTokenPressure;
}): PreemptiveCompactionDecision;
export declare function formatPrePromptPrecheckLog(params: {
    result: PreemptiveCompactionDecision;
    sessionKey?: string;
    sessionId?: string;
    provider: string;
    modelId: string;
    messageCount: number;
    unwindowedMessageCount?: number;
    contextTokenBudget: number;
    reserveTokens: number;
    sessionFile?: string;
}): string;
