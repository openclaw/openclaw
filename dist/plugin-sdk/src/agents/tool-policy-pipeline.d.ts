import type { AnyAgentTool } from "./pi-tools.types.js";
import { type ToolPolicyLike } from "./tool-policy.js";
export type ToolPolicyPipelineStep = {
    policy: ToolPolicyLike | undefined;
    label: string;
    stripPluginOnlyAllowlist?: boolean;
    suppressUnavailableCoreToolWarning?: boolean;
    suppressUnavailableCoreToolWarningAllowlist?: string[];
    unavailableCoreToolReason?: string;
};
export declare function buildDefaultToolPolicyPipelineSteps(params: {
    profilePolicy?: ToolPolicyLike;
    profile?: string;
    profileUnavailableCoreWarningAllowlist?: string[];
    providerProfilePolicy?: ToolPolicyLike;
    providerProfile?: string;
    providerProfileUnavailableCoreWarningAllowlist?: string[];
    globalPolicy?: ToolPolicyLike;
    globalProviderPolicy?: ToolPolicyLike;
    agentPolicy?: ToolPolicyLike;
    agentProviderPolicy?: ToolPolicyLike;
    groupPolicy?: ToolPolicyLike;
    senderPolicy?: ToolPolicyLike;
    agentId?: string;
    unavailableCoreToolReason?: string;
}): ToolPolicyPipelineStep[];
export declare function applyToolPolicyPipeline(params: {
    tools: AnyAgentTool[];
    toolMeta: (tool: AnyAgentTool) => {
        pluginId: string;
    } | undefined;
    warn: (message: string) => void;
    steps: ToolPolicyPipelineStep[];
}): AnyAgentTool[];
export declare function resetToolPolicyWarningCacheForTest(): void;
