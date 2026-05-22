import type { resolveProviderScopedAuthProfile } from "./agent-runner-auth-profile.js";
import type { FollowupRun } from "./queue.js";
export type ReasoningTagProviderResolver = (provider: string, options: {
    config: FollowupRun["run"]["config"];
    workspaceDir: string;
    modelId: string;
}) => boolean;
export declare const resolveEnforceFinalTagWithResolver: (run: FollowupRun["run"], provider: string, model?: string, isReasoningTagProvider?: ReasoningTagProviderResolver) => boolean;
export declare function resolveModelFallbackOptions(run: FollowupRun["run"], configOverride?: FollowupRun["run"]["config"]): {
    cfg: import("openclaw/plugin-sdk").OpenClawConfig;
    provider: string;
    model: string;
    agentDir: string;
    fallbacksOverride: string[] | undefined;
};
export declare function buildEmbeddedRunBaseParams(params: {
    run: FollowupRun["run"];
    provider: string;
    model: string;
    runId: string;
    authProfile: ReturnType<typeof resolveProviderScopedAuthProfile>;
    allowTransientCooldownProbe?: boolean;
    isReasoningTagProvider?: ReasoningTagProviderResolver;
}): {
    authProfileId?: string;
    authProfileIdSource?: "auto" | "user";
    sessionFile: string;
    workspaceDir: string;
    agentDir: string;
    config: import("openclaw/plugin-sdk").OpenClawConfig;
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
