import { resolveCommandSecretRefsViaGateway } from "../../cli/command-secret-gateway.js";
import { getScopedChannelsCommandSecretTargets } from "../../cli/command-secret-targets.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { runMessageAction } from "../../infra/outbound/message-action-runner.js";
import type { AnyAgentTool } from "./common.js";
type MessageToolOptions = {
    agentAccountId?: string;
    agentSessionKey?: string;
    sessionId?: string;
    config?: OpenClawConfig;
    getRuntimeConfig?: () => OpenClawConfig;
    getScopedChannelsCommandSecretTargets?: typeof getScopedChannelsCommandSecretTargets;
    resolveCommandSecretRefsViaGateway?: typeof resolveCommandSecretRefsViaGateway;
    runMessageAction?: typeof runMessageAction;
    currentChannelId?: string;
    currentChannelProvider?: string;
    currentThreadTs?: string;
    currentMessageId?: string | number;
    replyToMode?: "off" | "first" | "all" | "batched";
    hasRepliedRef?: {
        value: boolean;
    };
    sandboxRoot?: string;
    requireExplicitTarget?: boolean;
    requesterSenderId?: string;
    senderIsOwner?: boolean;
};
export declare function createMessageTool(options?: MessageToolOptions): AnyAgentTool;
export {};
