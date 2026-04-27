import type { PluginHookAgentContext } from "../../plugins/hook-types.js";
export type AgentHarnessHookContext = {
    runId: string;
    agentId?: string;
    sessionKey?: string;
    sessionId?: string;
    workspaceDir?: string;
    messageProvider?: string;
    trigger?: string;
    channelId?: string;
};
export declare function buildAgentHookContext(params: AgentHarnessHookContext): PluginHookAgentContext;
