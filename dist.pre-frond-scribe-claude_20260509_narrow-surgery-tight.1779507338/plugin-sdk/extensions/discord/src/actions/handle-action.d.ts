import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ChannelMessageActionContext } from "openclaw/plugin-sdk/channel-contract";
export declare function handleDiscordMessageAction(ctx: Pick<ChannelMessageActionContext, "action" | "params" | "cfg" | "accountId" | "requesterSenderId" | "toolContext" | "mediaAccess" | "mediaLocalRoots" | "mediaReadFile" | "sessionKey" | "inboundEventKind">): Promise<AgentToolResult<unknown>>;
