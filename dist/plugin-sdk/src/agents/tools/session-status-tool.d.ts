import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { AnyAgentTool } from "./common.js";
export declare function createSessionStatusTool(opts?: {
    agentSessionKey?: string;
    /**
     * The actual live run session key. When the tool is constructed with a sandbox/policy
     * session key (e.g. a Telegram direct peer key), this allows `session_status({sessionKey:
     * "current"})` to resolve to the live run session instead of the stale sandbox key.
     */
    runSessionKey?: string;
    config?: OpenClawConfig;
    sandboxed?: boolean;
    activeModelProvider?: string;
    activeModelId?: string;
}): AnyAgentTool;
