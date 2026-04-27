import type { EmbeddedRunAttemptParams } from "./types.js";
export type OrphanedTrailingUserPromptMergeParams = {
    prompt: string;
    trigger: EmbeddedRunAttemptParams["trigger"];
    leafMessage: {
        content?: unknown;
    };
};
export type OrphanedTrailingUserPromptMergeResult = {
    prompt: string;
    merged: boolean;
    /**
     * When false, the active session leaf is preserved. Use this only when the
     * caller intentionally accepts that the next appended prompt may follow an
     * existing user leaf; most providers reject consecutive user turns.
     */
    removeLeaf: boolean;
};
export type MessageMergeStrategyId = "orphan-trailing-user-prompt";
export type MessageMergeStrategy = {
    id: MessageMergeStrategyId;
    mergeOrphanedTrailingUserPrompt: (params: OrphanedTrailingUserPromptMergeParams) => OrphanedTrailingUserPromptMergeResult;
};
export declare const DEFAULT_MESSAGE_MERGE_STRATEGY_ID: MessageMergeStrategyId;
export declare function resolveMessageMergeStrategy(): MessageMergeStrategy;
export declare function registerMessageMergeStrategyForTest(strategy: MessageMergeStrategy): () => void;
