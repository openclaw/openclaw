import type { OpenClawConfig } from "../../config/config.js";
import type { AnyAgentTool } from "./common.js";
export declare function createSessionStatusTool(opts?: {
    agentSessionKey?: string;
    config?: OpenClawConfig;
}): AnyAgentTool;
