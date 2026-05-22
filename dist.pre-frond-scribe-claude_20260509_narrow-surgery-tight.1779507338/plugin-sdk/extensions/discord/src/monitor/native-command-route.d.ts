import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import * as conversationRuntime from "openclaw/plugin-sdk/conversation-binding-runtime";
import type { ResolvedAgentRoute } from "openclaw/plugin-sdk/routing";
import type { ThreadBindingRecord } from "./thread-bindings.js";
type ResolvedConfiguredBindingRoute = ReturnType<typeof conversationRuntime.resolveConfiguredBindingRoute>;
type ConfiguredBindingResolution = NonNullable<NonNullable<ResolvedConfiguredBindingRoute>["bindingResolution"]>;
type DiscordNativeInteractionRouteState = {
    route: ResolvedAgentRoute;
    effectiveRoute: ResolvedAgentRoute;
    boundSessionKey?: string;
    configuredRoute: ResolvedConfiguredBindingRoute | null;
    configuredBinding: ConfiguredBindingResolution | null;
    bindingReadiness: Awaited<ReturnType<typeof conversationRuntime.ensureConfiguredBindingRouteReady>> | null;
};
export declare function resolveDiscordNativeInteractionRouteState(params: {
    cfg: OpenClawConfig;
    accountId: string;
    guildId?: string;
    memberRoleIds?: string[];
    isDirectMessage: boolean;
    isGroupDm: boolean;
    directUserId?: string;
    conversationId: string;
    parentConversationId?: string;
    threadBinding?: ThreadBindingRecord;
    enforceConfiguredBindingReadiness?: boolean;
}): Promise<DiscordNativeInteractionRouteState>;
export {};
