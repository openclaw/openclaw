import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
export type ResolveDiscordOutboundSessionRouteParams = {
    cfg: OpenClawConfig;
    agentId: string;
    accountId?: string | null;
    target: string;
    resolvedTarget?: {
        kind: string;
    };
    replyToId?: string | null;
    threadId?: string | number | null;
};
export declare function resolveDiscordOutboundSessionRoute(params: ResolveDiscordOutboundSessionRouteParams): import("openclaw/plugin-sdk/channel-runtime").ChannelOutboundSessionRoute | null;
