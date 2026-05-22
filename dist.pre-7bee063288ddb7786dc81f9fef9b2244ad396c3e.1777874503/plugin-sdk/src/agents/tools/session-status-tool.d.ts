import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { AnyAgentTool } from "./common.js";
export declare function createSessionStatusTool(opts?: {
    agentSessionKey?: string;
    config?: OpenClawConfig;
    getConfig?: () => OpenClawConfig;
    sandboxed?: boolean;
}): AnyAgentTool;
