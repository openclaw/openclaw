import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ChannelMessageActionContext } from "openclaw/plugin-sdk/channel-contract";
type SlackActionInvoke = (action: Record<string, unknown>, cfg: ChannelMessageActionContext["cfg"], toolContext?: ChannelMessageActionContext["toolContext"]) => Promise<AgentToolResult<unknown>>;
/** Translate generic channel action requests into Slack-specific tool invocations and payload shapes. */
export declare function handleSlackMessageAction(params: {
    providerId: string;
    ctx: ChannelMessageActionContext;
    invoke: SlackActionInvoke;
    normalizeChannelId?: (channelId: string) => string;
    includeReadThreadId?: boolean;
}): Promise<AgentToolResult<unknown>>;
export {};
