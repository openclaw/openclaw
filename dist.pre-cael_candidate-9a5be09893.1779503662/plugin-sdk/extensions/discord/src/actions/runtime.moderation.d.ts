import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { type ActionGate, type DiscordActionConfig, type OpenClawConfig } from "../runtime-api.js";
import { banMemberDiscord, hasAnyGuildPermissionDiscord, kickMemberDiscord, timeoutMemberDiscord } from "../send.js";
export declare const discordModerationActionRuntime: {
    banMemberDiscord: typeof banMemberDiscord;
    hasAnyGuildPermissionDiscord: typeof hasAnyGuildPermissionDiscord;
    kickMemberDiscord: typeof kickMemberDiscord;
    timeoutMemberDiscord: typeof timeoutMemberDiscord;
};
export declare function handleDiscordModerationAction(action: string, params: Record<string, unknown>, isActionEnabled: ActionGate<DiscordActionConfig>, cfg: OpenClawConfig): Promise<AgentToolResult<unknown>>;
