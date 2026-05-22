import { IMPLICIT_ALLOW_ALL_FROM_ALSO_ALLOW } from "./sandbox-tool-policy.js";
export { expandToolGroups, normalizeToolList, normalizeToolName, resolveToolProfilePolicy, TOOL_GROUPS, } from "./tool-policy-shared.js";
export type { ToolProfileId } from "./tool-policy-shared.js";
export type ToolPolicyLike = {
    allow?: string[];
    deny?: string[];
    [IMPLICIT_ALLOW_ALL_FROM_ALSO_ALLOW]?: true;
};
export type PluginToolGroups = {
    all: string[];
    byPlugin: Map<string, string[]>;
};
export type AllowlistResolution = {
    policy: ToolPolicyLike | undefined;
    unknownAllowlist: string[];
    pluginOnlyAllowlist: boolean;
};
export declare const DEFAULT_PLUGIN_TOOLS_ALLOWLIST_ENTRY = "__openclaw_default_plugin_tools__";
export declare function hasRestrictiveAllowPolicy(policy?: {
    allow?: string[];
}): boolean;
export declare function replaceWithEffectiveToolAllowlist(target: string[], tools: Array<{
    name: string;
}>): void;
export declare function collectExplicitAllowlist(policies: Array<ToolPolicyLike | undefined>): string[];
export declare function collectExplicitDenylist(policies: Array<ToolPolicyLike | undefined>): string[];
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
export declare function analyzeAllowlistByToolType(policy: ToolPolicyLike | undefined, groups: PluginToolGroups, coreTools: Set<string>): AllowlistResolution;
export declare function mergeAlsoAllowPolicy<TPolicy extends {
    allow?: string[];
}>(policy: TPolicy | undefined, alsoAllow?: string[]): TPolicy | undefined;
