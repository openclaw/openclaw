import type { OpenClawConfig } from "../config/types.openclaw.js";
export declare function shouldIncludeHeartbeatGuidanceForSystemPrompt(params: {
    config?: OpenClawConfig;
    agentId?: string;
    defaultAgentId?: string;
}): boolean;
export declare function resolveHeartbeatPromptForSystemPrompt(params: {
    config?: OpenClawConfig;
    agentId?: string;
    defaultAgentId?: string;
}): string | undefined;
