import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { AnyAgentTool } from "./pi-tools.types.js";
export declare function isLocalModelLeanEnabled(params: {
    config?: OpenClawConfig;
    agentId?: string;
    sessionKey?: string;
}): boolean;
export declare function filterLocalModelLeanTools(params: {
    tools: AnyAgentTool[];
    config?: OpenClawConfig;
    agentId?: string;
    sessionKey?: string;
}): AnyAgentTool[];
