import type { AnyAgentTool } from "./pi-tools.types.js";
import { type ToolPolicyLike } from "./tool-policy.js";
export type ToolPolicyPipelineStep = {
    policy: ToolPolicyLike | undefined;
    label: string;
    stripPluginOnlyAllowlist?: boolean;
};
export declare function buildDefaultToolPolicyPipelineSteps(params: {
    profilePolicy?: ToolPolicyLike;
    profile?: string;
    providerProfilePolicy?: ToolPolicyLike;
    providerProfile?: string;
    globalPolicy?: ToolPolicyLike;
    globalProviderPolicy?: ToolPolicyLike;
    agentPolicy?: ToolPolicyLike;
    agentProviderPolicy?: ToolPolicyLike;
    groupPolicy?: ToolPolicyLike;
    agentId?: string;
}): ToolPolicyPipelineStep[];
export declare function applyToolPolicyPipeline(params: {
    tools: AnyAgentTool[];
    toolMeta: (tool: AnyAgentTool) => {
        pluginId: string;
    } | undefined;
    warn: (message: string) => void;
    steps: ToolPolicyPipelineStep[];
}): AnyAgentTool[];
