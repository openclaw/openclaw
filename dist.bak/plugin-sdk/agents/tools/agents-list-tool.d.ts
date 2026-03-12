import type { AnyAgentTool } from "./common.js";
export declare function createAgentsListTool(opts?: {
    agentSessionKey?: string;
    /** Explicit agent ID override for cron/hook sessions. */
    requesterAgentIdOverride?: string;
}): AnyAgentTool;
