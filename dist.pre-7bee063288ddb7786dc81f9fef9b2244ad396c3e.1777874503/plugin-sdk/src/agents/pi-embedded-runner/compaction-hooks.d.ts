import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { getGlobalHookRunner } from "../../plugins/hook-runner-global.js";
export declare function runPostCompactionSideEffects(params: {
    config?: OpenClawConfig;
    sessionKey?: string;
    sessionFile: string;
}): Promise<void>;
export type CompactionHookRunner = {
    hasHooks?: (hookName?: string) => boolean;
    runBeforeCompaction?: (metrics: {
        messageCount: number;
        tokenCount?: number;
        sessionFile?: string;
    }, context: {
        sessionId: string;
        agentId: string;
        sessionKey: string;
        workspaceDir: string;
        messageProvider?: string;
    }) => Promise<void> | void;
    runAfterCompaction?: (metrics: {
        messageCount: number;
        tokenCount?: number;
        compactedCount: number;
        sessionFile: string;
    }, context: {
        sessionId: string;
        agentId: string;
        sessionKey: string;
        workspaceDir: string;
        messageProvider?: string;
    }) => Promise<void> | void;
};
export declare function asCompactionHookRunner(hookRunner: ReturnType<typeof getGlobalHookRunner> | null | undefined): CompactionHookRunner | null;
export declare function buildBeforeCompactionHookMetrics(params: {
    originalMessages: AgentMessage[];
    currentMessages: AgentMessage[];
    observedTokenCount?: number;
    estimateTokensFn: (message: AgentMessage) => number;
}): {
    messageCountOriginal: number;
    tokenCountOriginal: number | undefined;
    messageCountBefore: number;
    tokenCountBefore: number | undefined;
};
export declare function runBeforeCompactionHooks(params: {
    hookRunner?: CompactionHookRunner | null;
    sessionId: string;
    sessionKey?: string;
    sessionAgentId: string;
    workspaceDir: string;
    messageProvider?: string;
    metrics: ReturnType<typeof buildBeforeCompactionHookMetrics>;
}): Promise<{
    hookSessionKey: string;
    missingSessionKey: boolean;
}>;
export declare function estimateTokensAfterCompaction(params: {
    messagesAfter: AgentMessage[];
    observedTokenCount?: number;
    fullSessionTokensBefore: number;
    estimateTokensFn: (message: AgentMessage) => number;
}): number | undefined;
export declare function runAfterCompactionHooks(params: {
    hookRunner?: CompactionHookRunner | null;
    sessionId: string;
    sessionAgentId: string;
    hookSessionKey: string;
    missingSessionKey: boolean;
    workspaceDir: string;
    messageProvider?: string;
    messageCountAfter: number;
    tokensAfter?: number;
    compactedCount: number;
    sessionFile: string;
    summaryLength?: number;
    tokensBefore?: number;
    firstKeptEntryId?: string;
}): Promise<void>;
