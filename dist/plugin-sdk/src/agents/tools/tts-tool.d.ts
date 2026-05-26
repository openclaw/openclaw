import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { GatewayMessageChannel } from "../../utils/message-channel.js";
import type { AnyAgentTool } from "./common.js";
export declare function createTtsTool(opts?: {
    config?: OpenClawConfig;
    agentChannel?: GatewayMessageChannel;
    agentId?: string;
    agentAccountId?: string;
}): AnyAgentTool;
