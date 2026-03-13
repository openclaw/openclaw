import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { ChannelMessageActionContext } from "../../types.js";
type Ctx = Pick<ChannelMessageActionContext, "action" | "params" | "cfg" | "accountId" | "requesterSenderId">;
export declare function tryHandleDiscordMessageActionGuildAdmin(params: {
    ctx: Ctx;
    resolveChannelId: () => string;
    readParentIdParam: (params: Record<string, unknown>) => string | null | undefined;
}): Promise<AgentToolResult<unknown> | undefined>;
export {};
