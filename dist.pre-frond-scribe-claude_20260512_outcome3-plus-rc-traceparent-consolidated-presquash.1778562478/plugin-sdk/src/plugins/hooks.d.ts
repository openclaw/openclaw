/**
 * Plugin Hook Runner
 *
 * Provides utilities for executing plugin lifecycle hooks with proper
 * error handling, priority ordering, and async support.
 */
import type { GlobalHookRunnerRegistry } from "./hook-registry.types.js";
import type { PluginHookAfterCompactionEvent, PluginHookAfterToolCallEvent, PluginHookAgentContext, PluginHookAgentEndEvent, PluginHookBeforeAgentFinalizeEvent, PluginHookBeforeAgentFinalizeResult, PluginHookBeforeAgentReplyEvent, PluginHookBeforeAgentReplyResult, PluginHookBeforeAgentStartEvent, PluginHookBeforeAgentStartResult, PluginHookBeforeDispatchContext, PluginHookBeforeDispatchEvent, PluginHookBeforeDispatchResult, PluginHookReplyDispatchContext, PluginHookReplyDispatchEvent, PluginHookReplyDispatchResult, PluginHookBeforeModelResolveEvent, PluginHookBeforeModelResolveResult, PluginHookBeforePromptBuildEvent, PluginHookBeforePromptBuildResult, PluginHookBeforeCompactionEvent, PluginHookModelCallEndedEvent, PluginHookModelCallStartedEvent, PluginHookInboundClaimContext, PluginHookInboundClaimEvent, PluginHookInboundClaimResult, PluginHookLlmInputEvent, PluginHookLlmOutputEvent, PluginHookBeforeResetEvent, PluginHookBeforeToolCallEvent, PluginHookBeforeToolCallResult, PluginAgentTurnPrepareEvent, PluginAgentTurnPrepareResult, PluginHeartbeatPromptContributionEvent, PluginHeartbeatPromptContributionResult, PluginHookCronChangedEvent, PluginHookGatewayCronDeliveryStatus, PluginHookGatewayCronJobState, PluginHookGatewayCronRunStatus, PluginHookGatewayContext, PluginHookGatewayStartEvent, PluginHookGatewayStopEvent, PluginHookMessageContext, PluginHookMessageReceivedEvent, PluginHookMessageSendingEvent, PluginHookMessageSendingResult, PluginHookMessageSentEvent, PluginHookName, PluginHookSessionContext, PluginHookSessionEndEvent, PluginHookSessionStartEvent, PluginHookSubagentContext, PluginHookSubagentDeliveryTargetEvent, PluginHookSubagentDeliveryTargetResult, PluginHookSubagentSpawningEvent, PluginHookSubagentSpawningResult, PluginHookSubagentEndedEvent, PluginHookSubagentSpawnedEvent, PluginHookToolContext, PluginHookToolResultPersistContext, PluginHookToolResultPersistEvent, PluginHookToolResultPersistResult, PluginHookBeforeMessageWriteEvent, PluginHookBeforeMessageWriteResult, PluginHookBeforeInstallContext, PluginHookBeforeInstallEvent, PluginHookBeforeInstallResult } from "./hook-types.js";
export type { PluginHookAgentContext, PluginHookBeforeAgentReplyEvent, PluginHookBeforeAgentReplyResult, PluginHookBeforeAgentStartEvent, PluginHookBeforeAgentStartResult, PluginHookBeforeDispatchContext, PluginHookBeforeDispatchEvent, PluginHookBeforeDispatchResult, PluginHookReplyDispatchContext, PluginHookReplyDispatchEvent, PluginHookReplyDispatchResult, PluginHookBeforeModelResolveEvent, PluginHookBeforeModelResolveResult, PluginHookBeforePromptBuildEvent, PluginHookBeforePromptBuildResult, PluginHookModelCallEndedEvent, PluginHookModelCallStartedEvent, PluginHookLlmInputEvent, PluginHookLlmOutputEvent, PluginHookBeforeAgentFinalizeEvent, PluginHookBeforeAgentFinalizeResult, PluginHookAgentEndEvent, PluginHookBeforeCompactionEvent, PluginHookBeforeResetEvent, PluginHookInboundClaimContext, PluginHookInboundClaimEvent, PluginHookInboundClaimResult, PluginHookAfterCompactionEvent, PluginHookMessageContext, PluginHookMessageReceivedEvent, PluginHookMessageSendingEvent, PluginHookMessageSendingResult, PluginHookMessageSentEvent, PluginHookToolContext, PluginHookBeforeToolCallEvent, PluginHookBeforeToolCallResult, PluginHookAfterToolCallEvent, PluginHookToolResultPersistContext, PluginHookToolResultPersistEvent, PluginHookToolResultPersistResult, PluginHookBeforeMessageWriteEvent, PluginHookBeforeMessageWriteResult, PluginHookSessionContext, PluginHookSessionStartEvent, PluginHookSessionEndEvent, PluginHookSubagentContext, PluginHookSubagentDeliveryTargetEvent, PluginHookSubagentDeliveryTargetResult, PluginHookSubagentSpawningEvent, PluginHookSubagentSpawningResult, PluginHookSubagentSpawnedEvent, PluginHookSubagentEndedEvent, PluginHookCronChangedEvent, PluginHookGatewayCronDeliveryStatus, PluginHookGatewayCronJobState, PluginHookGatewayCronRunStatus, PluginHookGatewayContext, PluginHookGatewayStartEvent, PluginHookGatewayStopEvent, PluginHookBeforeInstallContext, PluginHookBeforeInstallEvent, PluginHookBeforeInstallResult, };
export type HookRunnerLogger = {
    debug?: (message: string) => void;
    warn: (message: string) => void;
    error: (message: string) => void;
};
export type HookFailurePolicy = "fail-open" | "fail-closed";
export type HookRunnerOptions = {
    logger?: HookRunnerLogger;
    /** If true, errors in hooks will be caught and logged instead of thrown */
    catchErrors?: boolean;
    /**
     * Optional per-hook failure policy.
     * Defaults to fail-open unless explicitly overridden for a hook name.
     */
    failurePolicyByHook?: Partial<Record<PluginHookName, HookFailurePolicy>>;
    /**
     * Optional timeout for void/observation hooks. A timed-out hook is logged and
     * the runner continues, but the plugin's underlying work is not cancelled.
     */
    voidHookTimeoutMsByHook?: Partial<Record<PluginHookName, number>>;
    /**
     * Optional timeout for modifying hooks. A timed-out hook is logged and skipped,
     * but the plugin's underlying work is not cancelled.
     */
    modifyingHookTimeoutMsByHook?: Partial<Record<PluginHookName, number>>;
};
export type PluginTargetedInboundClaimOutcome = {
    status: "handled";
    result: PluginHookInboundClaimResult;
} | {
    status: "missing_plugin";
} | {
    status: "no_handler";
} | {
    status: "declined";
} | {
    status: "error";
    error: string;
};
/**
 * Create a hook runner for a specific registry.
 */
export declare function createHookRunner(registry: GlobalHookRunnerRegistry, options?: HookRunnerOptions): {
    runBeforeModelResolve: (event: PluginHookBeforeModelResolveEvent, ctx: PluginHookAgentContext) => Promise<PluginHookBeforeModelResolveResult | undefined>;
    runAgentTurnPrepare: (event: PluginAgentTurnPrepareEvent, ctx: PluginHookAgentContext) => Promise<PluginAgentTurnPrepareResult | undefined>;
    runBeforePromptBuild: (event: PluginHookBeforePromptBuildEvent, ctx: PluginHookAgentContext) => Promise<PluginHookBeforePromptBuildResult | undefined>;
    runBeforeAgentStart: (event: PluginHookBeforeAgentStartEvent, ctx: PluginHookAgentContext) => Promise<PluginHookBeforeAgentStartResult | undefined>;
    runBeforeAgentReply: (event: PluginHookBeforeAgentReplyEvent, ctx: PluginHookAgentContext) => Promise<PluginHookBeforeAgentReplyResult | undefined>;
    runModelCallStarted: (event: PluginHookModelCallStartedEvent, ctx: PluginHookAgentContext) => Promise<void>;
    runModelCallEnded: (event: PluginHookModelCallEndedEvent, ctx: PluginHookAgentContext) => Promise<void>;
    runLlmInput: (event: PluginHookLlmInputEvent, ctx: PluginHookAgentContext) => Promise<void>;
    runLlmOutput: (event: PluginHookLlmOutputEvent, ctx: PluginHookAgentContext) => Promise<void>;
    runBeforeAgentFinalize: (event: PluginHookBeforeAgentFinalizeEvent, ctx: PluginHookAgentContext) => Promise<PluginHookBeforeAgentFinalizeResult | undefined>;
    runAgentEnd: (event: PluginHookAgentEndEvent, ctx: PluginHookAgentContext) => Promise<void>;
    runBeforeCompaction: (event: PluginHookBeforeCompactionEvent, ctx: PluginHookAgentContext) => Promise<void>;
    runAfterCompaction: (event: PluginHookAfterCompactionEvent, ctx: PluginHookAgentContext) => Promise<void>;
    runBeforeReset: (event: PluginHookBeforeResetEvent, ctx: PluginHookAgentContext) => Promise<void>;
    runInboundClaim: (event: PluginHookInboundClaimEvent, ctx: PluginHookInboundClaimContext) => Promise<PluginHookInboundClaimResult | undefined>;
    runInboundClaimForPlugin: (pluginId: string, event: PluginHookInboundClaimEvent, ctx: PluginHookInboundClaimContext) => Promise<PluginHookInboundClaimResult | undefined>;
    runInboundClaimForPluginOutcome: (pluginId: string, event: PluginHookInboundClaimEvent, ctx: PluginHookInboundClaimContext) => Promise<PluginTargetedInboundClaimOutcome>;
    runMessageReceived: (event: PluginHookMessageReceivedEvent, ctx: PluginHookMessageContext) => Promise<void>;
    runBeforeDispatch: (event: PluginHookBeforeDispatchEvent, ctx: PluginHookBeforeDispatchContext) => Promise<PluginHookBeforeDispatchResult | undefined>;
    runReplyDispatch: (event: PluginHookReplyDispatchEvent, ctx: PluginHookReplyDispatchContext) => Promise<PluginHookReplyDispatchResult | undefined>;
    runMessageSending: (event: PluginHookMessageSendingEvent, ctx: PluginHookMessageContext) => Promise<PluginHookMessageSendingResult | undefined>;
    runMessageSent: (event: PluginHookMessageSentEvent, ctx: PluginHookMessageContext) => Promise<void>;
    runBeforeToolCall: (event: PluginHookBeforeToolCallEvent, ctx: PluginHookToolContext) => Promise<PluginHookBeforeToolCallResult | undefined>;
    runAfterToolCall: (event: PluginHookAfterToolCallEvent, ctx: PluginHookToolContext) => Promise<void>;
    runToolResultPersist: (event: PluginHookToolResultPersistEvent, ctx: PluginHookToolResultPersistContext) => PluginHookToolResultPersistResult | undefined;
    runBeforeMessageWrite: (event: PluginHookBeforeMessageWriteEvent, ctx: {
        agentId?: string;
        sessionKey?: string;
    }) => PluginHookBeforeMessageWriteResult | undefined;
    runSessionStart: (event: PluginHookSessionStartEvent, ctx: PluginHookSessionContext) => Promise<void>;
    runSessionEnd: (event: PluginHookSessionEndEvent, ctx: PluginHookSessionContext) => Promise<void>;
    runSubagentSpawning: (event: PluginHookSubagentSpawningEvent, ctx: PluginHookSubagentContext) => Promise<PluginHookSubagentSpawningResult | undefined>;
    runSubagentDeliveryTarget: (event: PluginHookSubagentDeliveryTargetEvent, ctx: PluginHookSubagentContext) => Promise<PluginHookSubagentDeliveryTargetResult | undefined>;
    runSubagentSpawned: (event: PluginHookSubagentSpawnedEvent, ctx: PluginHookSubagentContext) => Promise<void>;
    runSubagentEnded: (event: PluginHookSubagentEndedEvent, ctx: PluginHookSubagentContext) => Promise<void>;
    runGatewayStart: (event: PluginHookGatewayStartEvent, ctx: PluginHookGatewayContext) => Promise<void>;
    runGatewayStop: (event: PluginHookGatewayStopEvent, ctx: PluginHookGatewayContext) => Promise<void>;
    runHeartbeatPromptContribution: (event: PluginHeartbeatPromptContributionEvent, ctx: PluginHookAgentContext) => Promise<PluginHeartbeatPromptContributionResult | undefined>;
    runCronChanged: (event: PluginHookCronChangedEvent, ctx: PluginHookGatewayContext) => Promise<void>;
    runBeforeInstall: (event: PluginHookBeforeInstallEvent, ctx: PluginHookBeforeInstallContext) => Promise<PluginHookBeforeInstallResult | undefined>;
    hasHooks: (hookName: PluginHookName) => boolean;
    getHookCount: (hookName: PluginHookName) => number;
};
export type HookRunner = ReturnType<typeof createHookRunner>;
export type SubagentLifecycleHookRunner = Pick<HookRunner, "hasHooks" | "runSubagentSpawning" | "runSubagentSpawned" | "runSubagentEnded">;
