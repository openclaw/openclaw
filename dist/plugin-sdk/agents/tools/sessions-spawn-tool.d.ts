import type { GatewayMessageChannel } from "../../utils/message-channel.js";
import type { SpawnedToolContext } from "../spawned-context.js";
import type { AnyAgentTool } from "./common.js";
export declare function createSessionsSpawnTool(opts?: {
    agentSessionKey?: string;
    agentChannel?: GatewayMessageChannel;
    agentAccountId?: string;
    agentTo?: string;
    agentThreadId?: string | number;
    sandboxed?: boolean;
    /** Explicit agent ID override for cron/hook sessions where session key parsing may not work. */
    requesterAgentIdOverride?: string;
} & SpawnedToolContext): AnyAgentTool;
