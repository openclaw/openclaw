import { createHookRunner } from "./hooks.js";
import type { PluginRegistry } from "./registry.js";
import type { PluginHookAgentContext, PluginHookRegistration } from "./types.js";
export declare function createMockPluginRegistry(hooks: Array<{
    hookName: string;
    handler: (...args: unknown[]) => unknown;
    pluginId?: string;
}>): PluginRegistry;
export declare const TEST_PLUGIN_AGENT_CTX: PluginHookAgentContext;
export declare function addTestHook(params: {
    registry: PluginRegistry;
    pluginId: string;
    hookName: PluginHookRegistration["hookName"];
    handler: PluginHookRegistration["handler"];
    priority?: number;
    timeoutMs?: number;
}): void;
export declare function addStaticTestHooks<TResult>(registry: PluginRegistry, params: {
    hookName: PluginHookRegistration["hookName"];
    hooks: ReadonlyArray<{
        pluginId: string;
        result: TResult;
        priority?: number;
        handler?: () => TResult | Promise<TResult>;
    }>;
}): void;
export declare function createHookRunnerWithRegistry(hooks: Array<{
    hookName: string;
    handler: (...args: unknown[]) => unknown;
    pluginId?: string;
}>, options?: Parameters<typeof createHookRunner>[1]): {
    registry: PluginRegistry;
    runner: {
        runBeforeModelResolve: (event: import("./hook-before-agent-start.types.ts").PluginHookBeforeModelResolveEvent, ctx: PluginHookAgentContext) => Promise<import("./hook-before-agent-start.types.ts").PluginHookBeforeModelResolveResult | undefined>;
        runAgentTurnPrepare: (event: import("./host-hook-turn-types.ts").PluginAgentTurnPrepareEvent, ctx: PluginHookAgentContext) => Promise<import("./host-hook-turn-types.ts").PluginAgentTurnPrepareResult | undefined>;
        runBeforePromptBuild: (event: import("./hook-before-agent-start.types.ts").PluginHookBeforePromptBuildEvent, ctx: PluginHookAgentContext) => Promise<import("./hook-before-agent-start.types.ts").PluginHookBeforePromptBuildResult | undefined>;
        runBeforeAgentStart: (event: import("./hook-before-agent-start.types.ts").PluginHookBeforeAgentStartEvent, ctx: PluginHookAgentContext) => Promise<import("./hook-before-agent-start.types.ts").PluginHookBeforeAgentStartResult | undefined>;
        runBeforeAgentReply: (event: import("./hook-types.ts").PluginHookBeforeAgentReplyEvent, ctx: PluginHookAgentContext) => Promise<import("./hook-types.ts").PluginHookBeforeAgentReplyResult | undefined>;
        runModelCallStarted: (event: import("./hook-types.ts").PluginHookModelCallStartedEvent, ctx: PluginHookAgentContext) => Promise<void>;
        runModelCallEnded: (event: import("./hook-types.ts").PluginHookModelCallEndedEvent, ctx: PluginHookAgentContext) => Promise<void>;
        runLlmInput: (event: import("./hook-types.ts").PluginHookLlmInputEvent, ctx: PluginHookAgentContext) => Promise<void>;
        runLlmOutput: (event: import("./hook-types.ts").PluginHookLlmOutputEvent, ctx: PluginHookAgentContext) => Promise<void>;
        runBeforeAgentFinalize: (event: import("./hook-types.ts").PluginHookBeforeAgentFinalizeEvent, ctx: PluginHookAgentContext) => Promise<import("./hook-types.ts").PluginHookBeforeAgentFinalizeResult | undefined>;
        runAgentEnd: (event: import("./hook-types.ts").PluginHookAgentEndEvent, ctx: PluginHookAgentContext) => Promise<void>;
        runBeforeCompaction: (event: import("./hook-types.ts").PluginHookBeforeCompactionEvent, ctx: PluginHookAgentContext) => Promise<void>;
        runAfterCompaction: (event: import("./hook-types.ts").PluginHookAfterCompactionEvent, ctx: PluginHookAgentContext) => Promise<void>;
        runBeforeReset: (event: import("./hook-types.ts").PluginHookBeforeResetEvent, ctx: PluginHookAgentContext) => Promise<void>;
        runInboundClaim: (event: import("./hook-message.types.ts").PluginHookInboundClaimEvent, ctx: import("./hook-message.types.ts").PluginHookInboundClaimContext) => Promise<import("./hook-types.ts").PluginHookInboundClaimResult | undefined>;
        runInboundClaimForPlugin: (pluginId: string, event: import("./hook-message.types.ts").PluginHookInboundClaimEvent, ctx: import("./hook-message.types.ts").PluginHookInboundClaimContext) => Promise<import("./hook-types.ts").PluginHookInboundClaimResult | undefined>;
        runInboundClaimForPluginOutcome: (pluginId: string, event: import("./hook-message.types.ts").PluginHookInboundClaimEvent, ctx: import("./hook-message.types.ts").PluginHookInboundClaimContext) => Promise<import("./hooks.js").PluginTargetedInboundClaimOutcome>;
        runMessageReceived: (event: import("./hook-message.types.ts").PluginHookMessageReceivedEvent, ctx: import("./hook-message.types.ts").PluginHookMessageContext) => Promise<void>;
        runBeforeDispatch: (event: import("./hook-types.ts").PluginHookBeforeDispatchEvent, ctx: import("./hook-types.ts").PluginHookBeforeDispatchContext) => Promise<import("./hook-types.ts").PluginHookBeforeDispatchResult | undefined>;
        runReplyDispatch: (event: import("./hook-types.ts").PluginHookReplyDispatchEvent, ctx: import("./hook-types.ts").PluginHookReplyDispatchContext) => Promise<import("./hook-types.ts").PluginHookReplyDispatchResult | undefined>;
        runMessageSending: (event: import("./hook-message.types.ts").PluginHookMessageSendingEvent, ctx: import("./hook-message.types.ts").PluginHookMessageContext) => Promise<import("./hook-message.types.ts").PluginHookMessageSendingResult | undefined>;
        runMessageSent: (event: import("./hook-message.types.ts").PluginHookMessageSentEvent, ctx: import("./hook-message.types.ts").PluginHookMessageContext) => Promise<void>;
        runBeforeToolCall: (event: import("./hook-types.ts").PluginHookBeforeToolCallEvent, ctx: import("./hook-types.ts").PluginHookToolContext) => Promise<import("./hook-types.ts").PluginHookBeforeToolCallResult | undefined>;
        runAfterToolCall: (event: import("./hook-types.ts").PluginHookAfterToolCallEvent, ctx: import("./hook-types.ts").PluginHookToolContext) => Promise<void>;
        runToolResultPersist: (event: import("./hook-types.ts").PluginHookToolResultPersistEvent, ctx: import("./hook-types.ts").PluginHookToolResultPersistContext) => import("./hook-types.ts").PluginHookToolResultPersistResult | undefined;
        runBeforeMessageWrite: (event: import("./hook-types.ts").PluginHookBeforeMessageWriteEvent, ctx: {
            agentId?: string;
            sessionKey?: string;
        }) => import("./hook-types.ts").PluginHookBeforeMessageWriteResult | undefined;
        runSessionStart: (event: import("./hook-types.ts").PluginHookSessionStartEvent, ctx: import("./hook-types.ts").PluginHookSessionContext) => Promise<void>;
        runSessionEnd: (event: import("./hook-types.ts").PluginHookSessionEndEvent, ctx: import("./hook-types.ts").PluginHookSessionContext) => Promise<void>;
        runSubagentSpawning: (event: import("./hook-types.ts").PluginHookSubagentSpawningEvent, ctx: import("./hook-types.ts").PluginHookSubagentContext) => Promise<import("./hook-types.ts").PluginHookSubagentSpawningResult | undefined>;
        runSubagentDeliveryTarget: (event: import("./hook-types.ts").PluginHookSubagentDeliveryTargetEvent, ctx: import("./hook-types.ts").PluginHookSubagentContext) => Promise<import("./hook-types.ts").PluginHookSubagentDeliveryTargetResult | undefined>;
        runSubagentSpawned: (event: import("./hook-types.ts").PluginHookSubagentSpawnedEvent, ctx: import("./hook-types.ts").PluginHookSubagentContext) => Promise<void>;
        runSubagentEnded: (event: import("./hook-types.ts").PluginHookSubagentEndedEvent, ctx: import("./hook-types.ts").PluginHookSubagentContext) => Promise<void>;
        runGatewayStart: (event: import("./hook-types.ts").PluginHookGatewayStartEvent, ctx: import("./hook-types.ts").PluginHookGatewayContext) => Promise<void>;
        runGatewayStop: (event: import("./hook-types.ts").PluginHookGatewayStopEvent, ctx: import("./hook-types.ts").PluginHookGatewayContext) => Promise<void>;
        runHeartbeatPromptContribution: (event: import("./host-hook-turn-types.ts").PluginHeartbeatPromptContributionEvent, ctx: PluginHookAgentContext) => Promise<import("./host-hook-turn-types.ts").PluginHeartbeatPromptContributionResult | undefined>;
        runCronChanged: (event: import("./hook-types.ts").PluginHookCronChangedEvent, ctx: import("./hook-types.ts").PluginHookGatewayContext) => Promise<void>;
        runBeforeInstall: (event: import("./hook-types.ts").PluginHookBeforeInstallEvent, ctx: import("./hook-types.ts").PluginHookBeforeInstallContext) => Promise<import("./hook-types.ts").PluginHookBeforeInstallResult | undefined>;
        hasHooks: (hookName: import("./hook-types.ts").PluginHookName) => boolean;
        getHookCount: (hookName: import("./hook-types.ts").PluginHookName) => number;
    };
};
