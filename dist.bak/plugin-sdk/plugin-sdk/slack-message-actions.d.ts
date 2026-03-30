import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { ChannelMessageActionContext } from "../channels/plugins/types.js";
type SlackActionInvoke = (action: Record<string, unknown>, cfg: ChannelMessageActionContext["cfg"], toolContext?: ChannelMessageActionContext["toolContext"]) => Promise<AgentToolResult<unknown>>;
export declare function handleSlackMessageAction(params: {
    providerId: string;
    ctx: ChannelMessageActionContext;
    invoke: SlackActionInvoke;
    normalizeChannelId?: (channelId: string) => string;
    includeReadThreadId?: boolean;
}): Promise<AgentToolResult<unknown>>;
export {};
