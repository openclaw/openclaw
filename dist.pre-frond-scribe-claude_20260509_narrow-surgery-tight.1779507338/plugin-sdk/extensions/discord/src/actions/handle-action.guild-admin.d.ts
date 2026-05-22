import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ChannelMessageActionContext } from "openclaw/plugin-sdk/channel-contract";
type Ctx = Pick<ChannelMessageActionContext, "action" | "params" | "cfg" | "accountId" | "requesterSenderId" | "mediaLocalRoots" | "mediaReadFile">;
export declare function tryHandleDiscordMessageActionGuildAdmin(params: {
    ctx: Ctx;
    resolveChannelId: () => string;
}): Promise<AgentToolResult<unknown> | undefined>;
export {};
