import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { ContextEnginePromptCacheInfo, ContextEngineRuntimeContext } from "../../../context-engine/types.js";
import type { PluginAgentTurnPrepareResult, PluginNextTurnInjectionRecord, PluginHookAgentContext, PluginHookBeforeAgentStartResult, PluginHookBeforePromptBuildResult } from "../../../plugins/types.js";
import { type NormalizedUsage } from "../../usage.js";
import type { EmbeddedRunAttemptParams } from "./types.js";
export type PromptBuildHookRunner = {
    hasHooks: (hookName: "agent_turn_prepare" | "heartbeat_prompt_contribution" | "before_prompt_build" | "before_agent_start") => boolean;
    runAgentTurnPrepare?: (event: {
        prompt: string;
        messages: unknown[];
        queuedInjections: PluginNextTurnInjectionRecord[];
    }, ctx: PluginHookAgentContext) => Promise<PluginAgentTurnPrepareResult | undefined>;
    runHeartbeatPromptContribution?: (event: {
        sessionKey?: string;
        agentId?: string;
        heartbeatName?: string;
    }, ctx: PluginHookAgentContext) => Promise<PluginAgentTurnPrepareResult | undefined>;
    runBeforePromptBuild: (event: {
        prompt: string;
        messages: unknown[];
    }, ctx: PluginHookAgentContext) => Promise<PluginHookBeforePromptBuildResult | undefined>;
    runBeforeAgentStart: (event: {
        prompt: string;
        messages: unknown[];
    }, ctx: PluginHookAgentContext) => Promise<PluginHookBeforeAgentStartResult | undefined>;
};
/**
 * Releases the per-run drained-injection cache. Call when a run terminates so
 * the cap stays headroom for active runs.
 */
export declare function forgetPromptBuildDrainCacheForRun(runId: string | undefined): void;
export declare function resolvePromptBuildHookResult(params: {
    config: OpenClawConfig;
    prompt: string;
    messages: unknown[];
    hookCtx: PluginHookAgentContext;
    hookRunner?: PromptBuildHookRunner | null;
    legacyBeforeAgentStartResult?: PluginHookBeforeAgentStartResult;
}): Promise<PluginHookBeforePromptBuildResult>;
export declare function resolvePromptModeForSession(sessionKey?: string): "minimal" | "full";
export declare function shouldInjectHeartbeatPrompt(params: {
    config?: OpenClawConfig;
    agentId?: string;
    defaultAgentId?: string;
    isDefaultAgent: boolean;
    trigger?: EmbeddedRunAttemptParams["trigger"];
}): boolean;
export declare function shouldWarnOnOrphanedUserRepair(trigger: EmbeddedRunAttemptParams["trigger"]): boolean;
export type PromptSubmissionSkipReason = "blank_user_prompt" | "empty_prompt_history_images";
export declare function resolvePromptSubmissionSkipReason(params: {
    prompt: string;
    messages: readonly unknown[];
    imageCount: number;
    runtimeOnly?: boolean;
}): PromptSubmissionSkipReason | null;
export declare function mergeOrphanedTrailingUserPrompt(params: {
    prompt: string;
    trigger: EmbeddedRunAttemptParams["trigger"];
    leafMessage: {
        content?: unknown;
    };
}): {
    prompt: string;
    merged: boolean;
    removeLeaf: boolean;
};
export declare function resolveAttemptFsWorkspaceOnly(params: {
    config?: OpenClawConfig;
    sessionAgentId: string;
}): boolean;
export declare function prependSystemPromptAddition(params: {
    systemPrompt: string;
    systemPromptAddition?: string;
}): string;
export declare function resolveAttemptPrependSystemContext(params: {
    sessionKey?: string;
    trigger?: EmbeddedRunAttemptParams["trigger"];
    hookPrependSystemContext?: string;
}): string | undefined;
/** Build runtime context passed into context-engine afterTurn hooks. */
export declare function buildAfterTurnRuntimeContext(params: {
    attempt: Pick<EmbeddedRunAttemptParams, "sessionKey" | "messageChannel" | "messageProvider" | "agentAccountId" | "currentChannelId" | "currentThreadTs" | "currentMessageId" | "config" | "skillsSnapshot" | "senderIsOwner" | "senderId" | "provider" | "modelId" | "thinkLevel" | "reasoningLevel" | "bashElevated" | "extraSystemPrompt" | "ownerNumbers" | "authProfileId">;
    workspaceDir: string;
    agentDir: string;
    tokenBudget?: number;
    currentTokenCount?: number;
    promptCache?: ContextEnginePromptCacheInfo;
}): ContextEngineRuntimeContext;
export declare function buildAfterTurnRuntimeContextFromUsage(params: Omit<Parameters<typeof buildAfterTurnRuntimeContext>[0], "currentTokenCount"> & {
    lastCallUsage?: NormalizedUsage;
}): ContextEngineRuntimeContext;
