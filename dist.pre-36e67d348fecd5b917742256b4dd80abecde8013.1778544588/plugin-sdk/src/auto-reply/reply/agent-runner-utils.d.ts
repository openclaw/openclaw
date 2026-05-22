import type { ChannelId, ChannelThreadingToolContext } from "../../channels/plugins/types.public.js";
import { type OpenClawConfig } from "../../config/config.js";
import type { TemplateContext } from "../templating.js";
import { resolveProviderScopedAuthProfile, resolveRunAuthProfile } from "./agent-runner-auth-profile.js";
export { resolveProviderScopedAuthProfile, resolveRunAuthProfile };
import { buildEmbeddedRunBaseParams as buildEmbeddedRunBaseParamsCore } from "./agent-runner-run-params.js";
export { resolveModelFallbackOptions } from "./agent-runner-run-params.js";
import type { FollowupRun } from "./queue.js";
export declare function resolveQueuedReplyRuntimeConfig(config: OpenClawConfig): OpenClawConfig;
export declare function resolveQueuedReplyExecutionConfig(config: OpenClawConfig, params?: {
    originatingChannel?: string;
    messageProvider?: string;
    originatingAccountId?: string;
    agentAccountId?: string;
}): Promise<OpenClawConfig>;
/**
 * Build provider-specific threading context for tool auto-injection.
 */
export declare function buildThreadingToolContext(params: {
    sessionCtx: TemplateContext;
    config: OpenClawConfig | undefined;
    hasRepliedRef: {
        value: boolean;
    } | undefined;
}): ChannelThreadingToolContext;
export declare const isBunFetchSocketError: (message?: string) => boolean;
export declare const formatBunFetchSocketError: (message: string) => string;
export declare const resolveEnforceFinalTag: (run: FollowupRun["run"], provider: string, model?: string) => boolean;
export declare function buildEmbeddedRunBaseParams(params: Parameters<typeof buildEmbeddedRunBaseParamsCore>[0]): {
    authProfileId?: string;
    authProfileIdSource?: "auto" | "user";
    sessionFile: string;
    workspaceDir: string;
    agentDir: string;
    config: OpenClawConfig;
    skillsSnapshot: import("../../agents/skills.ts").SkillSnapshot | undefined;
    ownerNumbers: string[] | undefined;
    inputProvenance: import("../../sessions/input-provenance.ts").InputProvenance | undefined;
    senderIsOwner: boolean | undefined;
    enforceFinalTag: boolean;
    silentExpected: boolean | undefined;
    allowEmptyAssistantReplyAsSilent: boolean | undefined;
    silentReplyPromptMode: import("../../agents/system-prompt.types.ts").SilentReplyPromptMode | undefined;
    sourceReplyDeliveryMode: import("openclaw/plugin-sdk/channel-reply-pipeline").SourceReplyDeliveryMode | undefined;
    provider: string;
    model: string;
    modelFallbacksOverride: string[] | undefined;
    thinkLevel: import("./directives.ts").ThinkLevel | undefined;
    verboseLevel: import("./directives.ts").VerboseLevel | undefined;
    reasoningLevel: import("./directives.ts").ReasoningLevel | undefined;
    execOverrides: Pick<import("../../agents/bash-tools.exec-types.ts").ExecToolDefaults, "ask" | "host" | "node" | "security"> | undefined;
    bashElevated: {
        enabled: boolean;
        allowed: boolean;
        defaultLevel: import("./directives.ts").ElevatedLevel;
    } | undefined;
    timeoutMs: number;
    runId: string;
    allowTransientCooldownProbe: boolean | undefined;
};
export declare function buildEmbeddedRunContexts(params: {
    run: FollowupRun["run"];
    sessionCtx: TemplateContext;
    hasRepliedRef: {
        value: boolean;
    } | undefined;
    provider: string;
}): {
    authProfile: {
        authProfileId?: string;
        authProfileIdSource?: "auto" | "user";
    };
    embeddedContext: {
        currentChannelId?: string;
        currentGraphChannelId?: string;
        currentChannelProvider?: ChannelId;
        currentThreadTs?: string;
        currentMessageId?: string | number;
        replyToMode?: "off" | "first" | "all" | "batched";
        hasRepliedRef?: {
            value: boolean;
        };
        skipCrossContextDecoration?: boolean;
        sessionId: string;
        sessionKey: string | undefined;
        sandboxSessionKey: string | undefined;
        agentId: string;
        messageProvider: string | undefined;
        agentAccountId: string | undefined;
        messageTo: string | undefined;
        messageThreadId: string | number | undefined;
        memberRoleIds: string[] | undefined;
    };
    senderContext: {
        senderId: string | undefined;
        senderName: string | undefined;
        senderUsername: string | undefined;
        senderE164: string | undefined;
    };
};
export declare function buildEmbeddedRunExecutionParams(params: {
    run: FollowupRun["run"];
    sessionCtx: TemplateContext;
    hasRepliedRef: {
        value: boolean;
    } | undefined;
    provider: string;
    model: string;
    runId: string;
    allowTransientCooldownProbe?: boolean;
}): {
    embeddedContext: {
        currentChannelId?: string;
        currentGraphChannelId?: string;
        currentChannelProvider?: ChannelId;
        currentThreadTs?: string;
        currentMessageId?: string | number;
        replyToMode?: "off" | "first" | "all" | "batched";
        hasRepliedRef?: {
            value: boolean;
        };
        skipCrossContextDecoration?: boolean;
        sessionId: string;
        sessionKey: string | undefined;
        sandboxSessionKey: string | undefined;
        agentId: string;
        messageProvider: string | undefined;
        agentAccountId: string | undefined;
        messageTo: string | undefined;
        messageThreadId: string | number | undefined;
        memberRoleIds: string[] | undefined;
    };
    senderContext: {
        senderId: string | undefined;
        senderName: string | undefined;
        senderUsername: string | undefined;
        senderE164: string | undefined;
    };
    runBaseParams: {
        authProfileId?: string;
        authProfileIdSource?: "auto" | "user";
        sessionFile: string;
        workspaceDir: string;
        agentDir: string;
        config: OpenClawConfig;
        skillsSnapshot: import("../../agents/skills.ts").SkillSnapshot | undefined;
        ownerNumbers: string[] | undefined;
        inputProvenance: import("../../sessions/input-provenance.ts").InputProvenance | undefined;
        senderIsOwner: boolean | undefined;
        enforceFinalTag: boolean;
        silentExpected: boolean | undefined;
        allowEmptyAssistantReplyAsSilent: boolean | undefined;
        silentReplyPromptMode: import("../../agents/system-prompt.types.ts").SilentReplyPromptMode | undefined;
        sourceReplyDeliveryMode: import("openclaw/plugin-sdk/channel-reply-pipeline").SourceReplyDeliveryMode | undefined;
        provider: string;
        model: string;
        modelFallbacksOverride: string[] | undefined;
        thinkLevel: import("./directives.ts").ThinkLevel | undefined;
        verboseLevel: import("./directives.ts").VerboseLevel | undefined;
        reasoningLevel: import("./directives.ts").ReasoningLevel | undefined;
        execOverrides: Pick<import("../../agents/bash-tools.exec-types.ts").ExecToolDefaults, "ask" | "host" | "node" | "security"> | undefined;
        bashElevated: {
            enabled: boolean;
            allowed: boolean;
            defaultLevel: import("./directives.ts").ElevatedLevel;
        } | undefined;
        timeoutMs: number;
        runId: string;
        allowTransientCooldownProbe: boolean | undefined;
    };
};
