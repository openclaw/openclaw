import type { User } from "../internal/discord.js";
import type { DiscordMessagePreflightParams } from "./message-handler.preflight.types.js";
export declare function resolveDiscordPreflightRoute(params: {
    preflight: DiscordMessagePreflightParams;
    author: User;
    isDirectMessage: boolean;
    isGroupDm: boolean;
    messageChannelId: string;
    memberRoleIds: string[];
    earlyThreadParentId?: string;
}): Promise<{
    conversationRuntime: typeof import("openclaw/plugin-sdk/conversation-binding-runtime");
    threadBinding: import("openclaw/plugin-sdk/conversation-binding-runtime").SessionBindingRecord | undefined;
    configuredBinding: import("openclaw/plugin-sdk").ConfiguredBindingResolution | null;
    boundSessionKey: string | undefined;
    effectiveRoute: import("openclaw/plugin-sdk/routing").ResolvedAgentRoute;
    boundAgentId: string | undefined;
    baseSessionKey: string;
}>;
