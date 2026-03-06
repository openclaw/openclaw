import type { OpenClawConfig } from "../config/config.js";
import type { AnyAgentTool } from "./pi-tools.types.js";
import type { SandboxToolPolicy } from "./sandbox.js";
export declare function resolveSubagentToolPolicy(cfg?: OpenClawConfig, depth?: number): SandboxToolPolicy;
export declare function isToolAllowedByPolicyName(name: string, policy?: SandboxToolPolicy): boolean;
export declare function filterToolsByPolicy(tools: AnyAgentTool[], policy?: SandboxToolPolicy): AnyAgentTool[];
export declare function resolveEffectiveToolPolicy(params: {
    config?: OpenClawConfig;
    sessionKey?: string;
    agentId?: string;
    modelProvider?: string;
    modelId?: string;
}): {
    agentId: string | undefined;
    globalPolicy: SandboxToolPolicy | undefined;
    globalProviderPolicy: SandboxToolPolicy | undefined;
    agentPolicy: SandboxToolPolicy | undefined;
    agentProviderPolicy: SandboxToolPolicy | undefined;
    profile: import("../config/types.tools.ts").ToolProfileId | undefined;
    providerProfile: string | undefined;
    profileAlsoAllow: string[] | undefined;
    providerProfileAlsoAllow: string[] | undefined;
};
export declare function resolveGroupToolPolicy(params: {
    config?: OpenClawConfig;
    sessionKey?: string;
    spawnedBy?: string | null;
    messageProvider?: string;
    groupId?: string | null;
    groupChannel?: string | null;
    groupSpace?: string | null;
    accountId?: string | null;
    senderId?: string | null;
    senderName?: string | null;
    senderUsername?: string | null;
    senderE164?: string | null;
}): SandboxToolPolicy | undefined;
export declare function isToolAllowedByPolicies(name: string, policies: Array<SandboxToolPolicy | undefined>): boolean;
