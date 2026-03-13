import type { OpenClawConfig } from "../config/config.js";
import type { ResolvedAgentRoute } from "../routing/resolve-route.js";
import { type ConfiguredAcpBindingChannel, type ResolvedConfiguredAcpBinding } from "./persistent-bindings.js";
export declare function resolveConfiguredAcpRoute(params: {
    cfg: OpenClawConfig;
    route: ResolvedAgentRoute;
    channel: ConfiguredAcpBindingChannel;
    accountId: string;
    conversationId: string;
    parentConversationId?: string;
}): {
    configuredBinding: ResolvedConfiguredAcpBinding | null;
    route: ResolvedAgentRoute;
    boundSessionKey?: string;
    boundAgentId?: string;
};
export declare function ensureConfiguredAcpRouteReady(params: {
    cfg: OpenClawConfig;
    configuredBinding: ResolvedConfiguredAcpBinding | null;
}): Promise<{
    ok: true;
} | {
    ok: false;
    error: string;
}>;
