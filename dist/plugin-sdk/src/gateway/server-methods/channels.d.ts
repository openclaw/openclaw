import { type ChannelId } from "../../channels/plugins/index.js";
import type { ChannelPlugin } from "../../channels/plugins/types.plugin.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { GatewayRequestContext, GatewayRequestHandlers } from "./types.js";
type ChannelLogoutPayload = {
    channel: ChannelId;
    accountId: string;
    cleared: boolean;
    [key: string]: unknown;
};
type ChannelStartPayload = {
    channel: ChannelId;
    accountId: string;
    started: boolean;
};
type ChannelStopPayload = {
    channel: ChannelId;
    accountId: string;
    stopped: boolean;
};
export declare function logoutChannelAccount(params: {
    channelId: ChannelId;
    accountId?: string | null;
    cfg: OpenClawConfig;
    context: GatewayRequestContext;
    plugin: ChannelPlugin;
}): Promise<ChannelLogoutPayload>;
export declare function startChannelAccount(params: {
    channelId: ChannelId;
    accountId?: string | null;
    cfg: OpenClawConfig;
    context: GatewayRequestContext;
    plugin: ChannelPlugin;
}): Promise<ChannelStartPayload>;
export declare function stopChannelAccount(params: {
    channelId: ChannelId;
    accountId?: string | null;
    cfg: OpenClawConfig;
    context: GatewayRequestContext;
    plugin: ChannelPlugin;
}): Promise<ChannelStopPayload>;
export declare const channelsHandlers: GatewayRequestHandlers;
export {};
