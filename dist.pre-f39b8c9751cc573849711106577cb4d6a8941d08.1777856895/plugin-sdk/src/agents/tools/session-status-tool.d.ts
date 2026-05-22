import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { AnyAgentTool } from "./common.js";
export declare function createSessionStatusTool(opts?: {
    agentSessionKey?: string;
    config?: OpenClawConfig;
    sandboxed?: boolean;
}): AnyAgentTool;
