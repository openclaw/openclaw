import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { AgentCompactionIdentifierPolicy } from "../config/types.agent-defaults.js";
export declare const BASE_CHUNK_RATIO = 0.4;
export declare const MIN_CHUNK_RATIO = 0.15;
export declare const SAFETY_MARGIN = 1.2;
export type CompactionSummarizationInstructions = {
    identifierPolicy?: AgentCompactionIdentifierPolicy;
    identifierInstructions?: string;
};
export declare function buildCompactionSummarizationInstructions(customInstructions?: string, instructions?: CompactionSummarizationInstructions): string | undefined;
export declare function estimateMessagesTokens(messages: AgentMessage[]): number;
export declare function splitMessagesByTokenShare(messages: AgentMessage[], parts?: number): AgentMessage[][];
export declare const SUMMARIZATION_OVERHEAD_TOKENS = 4096;
export declare function chunkMessagesByMaxTokens(messages: AgentMessage[], maxTokens: number): AgentMessage[][];
/**
 * Compute adaptive chunk ratio based on average message size.
 * When messages are large, we use smaller chunks to avoid exceeding model limits.
 */
export declare function computeAdaptiveChunkRatio(messages: AgentMessage[], contextWindow: number): number;
/**
 * Check if a single message is too large to summarize.
 * If single message > 50% of context, it can't be summarized safely.
 */
export declare function isOversizedForSummary(msg: AgentMessage, contextWindow: number): boolean;
/**
 * Summarize with progressive fallback for handling oversized messages.
 * If full summarization fails, tries partial summarization excluding oversized messages.
 */
export declare function summarizeWithFallback(params: {
    messages: AgentMessage[];
    model: NonNullable<ExtensionContext["model"]>;
    apiKey: string;
    signal: AbortSignal;
    reserveTokens: number;
    maxChunkTokens: number;
    contextWindow: number;
    customInstructions?: string;
    summarizationInstructions?: CompactionSummarizationInstructions;
    previousSummary?: string;
}): Promise<string>;
export declare function summarizeInStages(params: {
    messages: AgentMessage[];
    model: NonNullable<ExtensionContext["model"]>;
    apiKey: string;
    signal: AbortSignal;
    reserveTokens: number;
    maxChunkTokens: number;
    contextWindow: number;
    customInstructions?: string;
    summarizationInstructions?: CompactionSummarizationInstructions;
    previousSummary?: string;
    parts?: number;
    minMessagesForSplit?: number;
}): Promise<string>;
export declare function pruneHistoryForContextShare(params: {
    messages: AgentMessage[];
    maxContextTokens: number;
    maxHistoryShare?: number;
    parts?: number;
}): {
    messages: AgentMessage[];
    droppedMessagesList: AgentMessage[];
    droppedChunks: number;
    droppedMessages: number;
    droppedTokens: number;
    keptTokens: number;
    budgetTokens: number;
};
export declare function resolveContextWindowTokens(model?: ExtensionContext["model"]): number;
