import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ThinkLevel } from "../../auto-reply/thinking.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ProviderRuntimeModel } from "../../plugins/provider-runtime-model.types.js";
import { hasMeaningfulConversationContent } from "../compaction-real-conversation.js";
import type { AgentRuntimePlan } from "../runtime-plan/types.js";
import type { CompactEmbeddedPiSessionParams } from "./compact.types.js";
import { buildBeforeCompactionHookMetrics, estimateTokensAfterCompaction, runAfterCompactionHooks, runBeforeCompactionHooks, runPostCompactionSideEffects } from "./compaction-hooks.js";
import { hardenManualCompactionBoundary } from "./manual-compaction-boundary.js";
import type { EmbeddedPiCompactResult } from "./types.js";
export type { CompactEmbeddedPiSessionParams } from "./compact.types.js";
declare function hasRealConversationContent(msg: AgentMessage, messages: AgentMessage[], index: number): boolean;
declare function prepareCompactionSessionAgent(params: {
    session: {
        agent: {
            streamFn?: unknown;
        };
    };
    providerStreamFn: unknown;
    shouldUseWebSocketTransport: boolean;
    wsApiKey?: string;
    sessionId: string;
    signal: AbortSignal;
    effectiveModel: ProviderRuntimeModel;
    resolvedApiKey?: string;
    authStorage: unknown;
    config?: OpenClawConfig;
    provider: string;
    modelId: string;
    thinkLevel: ThinkLevel;
    sessionAgentId: string;
    effectiveWorkspace: string;
    agentDir: string;
    runtimePlan?: AgentRuntimePlan;
}): {
    effectiveExtraParams: Record<string, unknown>;
};
declare function resolveCompactionProviderStream(params: {
    effectiveModel: ProviderRuntimeModel;
    config?: OpenClawConfig;
    agentDir: string;
    effectiveWorkspace: string;
}): import("@mariozechner/pi-agent-core").StreamFn | undefined;
declare function containsRealConversationMessages(messages: AgentMessage[]): boolean;
/**
 * Core compaction logic without lane queueing.
 * Use this when already inside a session/global lane to avoid deadlocks.
 */
export declare function compactEmbeddedPiSessionDirect(params: CompactEmbeddedPiSessionParams): Promise<EmbeddedPiCompactResult>;
export declare const __testing: {
    readonly hasRealConversationContent: typeof hasRealConversationContent;
    readonly hasMeaningfulConversationContent: typeof hasMeaningfulConversationContent;
    readonly containsRealConversationMessages: typeof containsRealConversationMessages;
    readonly estimateTokensAfterCompaction: typeof estimateTokensAfterCompaction;
    readonly buildBeforeCompactionHookMetrics: typeof buildBeforeCompactionHookMetrics;
    readonly hardenManualCompactionBoundary: typeof hardenManualCompactionBoundary;
    readonly resolveCompactionProviderStream: typeof resolveCompactionProviderStream;
    readonly prepareCompactionSessionAgent: typeof prepareCompactionSessionAgent;
    readonly runBeforeCompactionHooks: typeof runBeforeCompactionHooks;
    readonly runAfterCompactionHooks: typeof runAfterCompactionHooks;
    readonly runPostCompactionSideEffects: typeof runPostCompactionSideEffects;
};
export { runPostCompactionSideEffects } from "./compaction-hooks.js";
