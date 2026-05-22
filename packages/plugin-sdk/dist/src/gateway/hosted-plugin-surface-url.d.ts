type HostSource = string | null | undefined;
export type HostedPluginSurfaceUrlParams = {
    port?: number;
    hostOverride?: HostSource;
    forwardedHost?: HostSource | HostSource[];
    requestHost?: HostSource;
    forwardedProto?: HostSource | HostSource[];
    localAddress?: HostSource;
    scheme?: "http" | "https";
};
export declare function resolveHostedPluginSurfaceUrl(params: HostedPluginSurfaceUrlParams): string | undefined;
export {};
