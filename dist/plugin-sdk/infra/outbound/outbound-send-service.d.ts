import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { ChannelId, ChannelThreadingToolContext } from "../../channels/plugins/types.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { GatewayClientMode, GatewayClientName } from "../../utils/message-channel.js";
import type { OutboundSendDeps } from "./deliver.js";
import type { MessagePollResult, MessageSendResult } from "./message.js";
export type OutboundGatewayContext = {
    url?: string;
    token?: string;
    timeoutMs?: number;
    clientName: GatewayClientName;
    clientDisplayName?: string;
    mode: GatewayClientMode;
};
export type OutboundSendContext = {
    cfg: OpenClawConfig;
    channel: ChannelId;
    params: Record<string, unknown>;
    /** Active agent id for per-agent outbound media root scoping. */
    agentId?: string;
    accountId?: string | null;
    gateway?: OutboundGatewayContext;
    toolContext?: ChannelThreadingToolContext;
    deps?: OutboundSendDeps;
    dryRun: boolean;
    mirror?: {
        sessionKey: string;
        agentId?: string;
        text?: string;
        mediaUrls?: string[];
    };
    abortSignal?: AbortSignal;
    silent?: boolean;
};
export declare function executeSendAction(params: {
    ctx: OutboundSendContext;
    to: string;
    message: string;
    mediaUrl?: string;
    mediaUrls?: string[];
    gifPlayback?: boolean;
    bestEffort?: boolean;
    replyToId?: string;
    threadId?: string | number;
}): Promise<{
    handledBy: "plugin" | "core";
    payload: unknown;
    toolResult?: AgentToolResult<unknown>;
    sendResult?: MessageSendResult;
}>;
export declare function executePollAction(params: {
    ctx: OutboundSendContext;
    to: string;
    question: string;
    options: string[];
    maxSelections: number;
    durationSeconds?: number;
    durationHours?: number;
    threadId?: string;
    isAnonymous?: boolean;
}): Promise<{
    handledBy: "plugin" | "core";
    payload: unknown;
    toolResult?: AgentToolResult<unknown>;
    pollResult?: MessagePollResult;
}>;
