import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { ChannelId, ChannelMessageActionName, ChannelThreadingToolContext } from "../../channels/plugins/types.js";
import type { OpenClawConfig } from "../../config/config.js";
import { type GatewayClientMode, type GatewayClientName } from "../../utils/message-channel.js";
import type { OutboundSendDeps } from "./deliver.js";
import type { MessagePollResult, MessageSendResult } from "./message.js";
export type MessageActionRunnerGateway = {
    url?: string;
    token?: string;
    timeoutMs?: number;
    clientName: GatewayClientName;
    clientDisplayName?: string;
    mode: GatewayClientMode;
};
export type RunMessageActionParams = {
    cfg: OpenClawConfig;
    action: ChannelMessageActionName;
    params: Record<string, unknown>;
    defaultAccountId?: string;
    requesterSenderId?: string | null;
    toolContext?: ChannelThreadingToolContext;
    gateway?: MessageActionRunnerGateway;
    deps?: OutboundSendDeps;
    sessionKey?: string;
    agentId?: string;
    sandboxRoot?: string;
    dryRun?: boolean;
    abortSignal?: AbortSignal;
};
export type MessageActionRunResult = {
    kind: "send";
    channel: ChannelId;
    action: "send";
    to: string;
    handledBy: "plugin" | "core";
    payload: unknown;
    toolResult?: AgentToolResult<unknown>;
    sendResult?: MessageSendResult;
    dryRun: boolean;
} | {
    kind: "broadcast";
    channel: ChannelId;
    action: "broadcast";
    handledBy: "core" | "dry-run";
    payload: {
        results: Array<{
            channel: ChannelId;
            to: string;
            ok: boolean;
            error?: string;
            result?: MessageSendResult;
        }>;
    };
    dryRun: boolean;
} | {
    kind: "poll";
    channel: ChannelId;
    action: "poll";
    to: string;
    handledBy: "plugin" | "core";
    payload: unknown;
    toolResult?: AgentToolResult<unknown>;
    pollResult?: MessagePollResult;
    dryRun: boolean;
} | {
    kind: "action";
    channel: ChannelId;
    action: Exclude<ChannelMessageActionName, "send" | "poll">;
    handledBy: "plugin" | "dry-run";
    payload: unknown;
    toolResult?: AgentToolResult<unknown>;
    dryRun: boolean;
};
export declare function getToolResult(result: MessageActionRunResult): AgentToolResult<unknown> | undefined;
export declare function runMessageAction(input: RunMessageActionParams): Promise<MessageActionRunResult>;
