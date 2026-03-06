import type { AnyAgentTool } from "./tools/common.js";
export { expandToolGroups, normalizeToolList, normalizeToolName, resolveToolProfilePolicy, TOOL_GROUPS, } from "./tool-policy-shared.js";
export type { ToolProfileId } from "./tool-policy-shared.js";
export declare function isOwnerOnlyToolName(name: string): boolean;
export declare function applyOwnerOnlyToolPolicy(tools: AnyAgentTool[], senderIsOwner: boolean): AnyAgentTool[];
export type ToolPolicyLike = {
    allow?: string[];
    deny?: string[];
};
export type PluginToolGroups = {
    all: string[];
    byPlugin: Map<string, string[]>;
};
export type AllowlistResolution = {
    policy: ToolPolicyLike | undefined;
    unknownAllowlist: string[];
    strippedAllowlist: boolean;
};
export declare function collectExplicitAllowlist(policies: Array<ToolPolicyLike | undefined>): string[];
export declare function buildPluginToolGroups<T extends {
    name: string;
}>(params: {
    tools: T[];
    toolMeta: (tool: T) => {
        pluginId: string;
    } | undefined;
}): PluginToolGroups;
export declare function expandPluginGroups(list: string[] | undefined, groups: PluginToolGroups): string[] | undefined;
export declare function expandPolicyWithPluginGroups(policy: ToolPolicyLike | undefined, groups: PluginToolGroups): ToolPolicyLike | undefined;
export declare function stripPluginOnlyAllowlist(policy: ToolPolicyLike | undefined, groups: PluginToolGroups, coreTools: Set<string>): AllowlistResolution;
export declare function mergeAlsoAllowPolicy<TPolicy extends {
    allow?: string[];
}>(policy: TPolicy | undefined, alsoAllow?: string[]): TPolicy | undefined;
