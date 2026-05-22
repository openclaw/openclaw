import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { SessionBindingRecord } from "openclaw/plugin-sdk/conversation-runtime";
import { type ResolvedAgentRoute, type RoutePeer } from "openclaw/plugin-sdk/routing";
export declare function buildDiscordRoutePeer(params: {
    isDirectMessage: boolean;
    isGroupDm: boolean;
    directUserId?: string | null;
    conversationId: string;
}): RoutePeer;
export declare function resolveDiscordConversationRoute(params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
    guildId?: string | null;
    memberRoleIds?: string[];
    peer: RoutePeer;
    parentConversationId?: string | null;
}): ResolvedAgentRoute;
export declare function resolveDiscordBoundConversationRoute(params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
    guildId?: string | null;
    memberRoleIds?: string[];
    isDirectMessage: boolean;
    isGroupDm: boolean;
    directUserId?: string | null;
    conversationId: string;
    parentConversationId?: string | null;
    boundSessionKey?: string | null;
    configuredRoute?: {
        route: ResolvedAgentRoute;
    } | null;
    matchedBy?: ResolvedAgentRoute["matchedBy"];
}): ResolvedAgentRoute;
export declare function resolveDiscordEffectiveRoute(params: {
    route: ResolvedAgentRoute;
    boundSessionKey?: string | null;
    configuredRoute?: {
        route: ResolvedAgentRoute;
    } | null;
    matchedBy?: ResolvedAgentRoute["matchedBy"];
}): ResolvedAgentRoute;
export declare function shouldIgnoreStaleDiscordRouteBinding(params: {
    bindingRecord?: SessionBindingRecord | null;
    route: ResolvedAgentRoute;
}): boolean;
