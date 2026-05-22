import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { AnyAgentTool } from "./pi-tools.types.js";
import type { SandboxToolPolicy } from "./sandbox.js";
import { type SessionCapabilityStore } from "./subagent-capabilities.js";
export declare function resolveSubagentToolPolicy(cfg?: OpenClawConfig, depth?: number): SandboxToolPolicy;
export declare function resolveSubagentToolPolicyForSession(cfg: OpenClawConfig | undefined, sessionKey: string, opts?: {
    store?: SessionCapabilityStore;
}): SandboxToolPolicy;
export declare function filterToolsByPolicy(tools: AnyAgentTool[], policy?: SandboxToolPolicy): AnyAgentTool[];
export declare function resolveTrustedGroupId(params: {
    groupId?: string | null;
    sessionKey?: string | null;
    spawnedBy?: string | null;
}): {
    groupId: string | null | undefined;
    dropped: boolean;
};
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
    profile: import("../config/types.tools.js").ToolProfileId | undefined;
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
export { isToolAllowedByPolicies, isToolAllowedByPolicyName } from "./tool-policy-match.js";
