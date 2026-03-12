import type { OpenClawConfig } from "../../config/config.js";
import type { AnyAgentTool } from "./common.js";
export declare function createMemorySearchTool(options: {
    config?: OpenClawConfig;
    agentSessionKey?: string;
}): AnyAgentTool | null;
export declare function createMemoryGetTool(options: {
    config?: OpenClawConfig;
    agentSessionKey?: string;
}): AnyAgentTool | null;
