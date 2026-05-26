import type { PluginHookAgentContext, PluginHookContextWindowSource } from "../../plugins/hook-types.js";
export type AgentHarnessHookContext = {
    runId: string;
    jobId?: string;
    agentId?: string;
    sessionKey?: string;
    sessionId?: string;
    workspaceDir?: string;
    modelProviderId?: string;
    modelId?: string;
    messageProvider?: string;
    trigger?: string;
    channelId?: string;
    contextTokenBudget?: number;
    contextWindowSource?: PluginHookContextWindowSource;
    contextWindowReferenceTokens?: number;
};
export declare function buildAgentHookContext(params: AgentHarnessHookContext): PluginHookAgentContext;
