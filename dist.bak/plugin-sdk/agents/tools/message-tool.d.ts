import type { OpenClawConfig } from "../../config/config.js";
import type { AnyAgentTool } from "./common.js";
type MessageToolOptions = {
    agentAccountId?: string;
    agentSessionKey?: string;
    config?: OpenClawConfig;
    currentChannelId?: string;
    currentChannelProvider?: string;
    currentThreadTs?: string;
    currentMessageId?: string | number;
    replyToMode?: "off" | "first" | "all";
    hasRepliedRef?: {
        value: boolean;
    };
    sandboxRoot?: string;
    requireExplicitTarget?: boolean;
    requesterSenderId?: string;
};
export declare function createMessageTool(options?: MessageToolOptions): AnyAgentTool;
export {};
