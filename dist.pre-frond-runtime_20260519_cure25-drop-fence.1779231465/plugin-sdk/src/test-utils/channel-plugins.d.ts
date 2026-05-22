import type { ChannelCapabilities, ChannelId, ChannelMessagingAdapter, ChannelOutboundAdapter, ChannelPlugin } from "../channels/plugins/types.public.js";
import type { PluginRegistry } from "../plugins/registry.js";
export type TestChannelRegistration = {
    pluginId: string;
    plugin: unknown;
    source: string;
};
export declare const createTestRegistry: (channels?: TestChannelRegistration[]) => PluginRegistry;
export declare const createChannelTestPluginBase: (params: {
    id: ChannelId;
    label?: string;
    docsPath?: string;
    markdownCapable?: boolean;
    capabilities?: ChannelCapabilities;
    config?: Partial<ChannelPlugin["config"]>;
}) => Pick<ChannelPlugin, "id" | "meta" | "capabilities" | "config">;
export declare const createMSTeamsTestPluginBase: () => Pick<ChannelPlugin, "id" | "meta" | "capabilities" | "config">;
export declare const createMSTeamsTestPlugin: (params?: {
    aliases?: string[];
    outbound?: ChannelOutboundAdapter;
}) => ChannelPlugin;
export declare const createOutboundTestPlugin: (params: {
    id: ChannelId;
    outbound: ChannelOutboundAdapter;
    messaging?: ChannelMessagingAdapter;
    label?: string;
    docsPath?: string;
    capabilities?: ChannelCapabilities;
}) => ChannelPlugin;
export type BindingResolverTestPlugin = Pick<ChannelPlugin, "id" | "meta" | "capabilities" | "config"> & {
    setup?: Pick<NonNullable<ChannelPlugin["setup"]>, "resolveBindingAccountId">;
};
export declare const createBindingResolverTestPlugin: (params: {
    id: ChannelId;
    label?: string;
    docsPath?: string;
    capabilities?: ChannelCapabilities;
    config?: Partial<ChannelPlugin["config"]>;
    resolveBindingAccountId?: NonNullable<ChannelPlugin["setup"]>["resolveBindingAccountId"];
}) => BindingResolverTestPlugin;
