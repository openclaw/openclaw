export declare const PLUGIN_NODE_CAPABILITY_PATH_PREFIX = "/__openclaw__/cap";
export declare const DEFAULT_PLUGIN_NODE_CAPABILITY_TTL_MS: number;
export type PluginNodeCapabilitySurface = {
    surface: string;
    ttlMs?: number;
    scopeKey?: string;
};
export type PluginNodeCapabilityClient = {
    pluginSurfaceUrls?: Record<string, string>;
    pluginNodeCapabilitySurfaces?: Record<string, PluginNodeCapabilitySurface>;
    pluginNodeCapabilities?: Record<string, {
        capability: string;
        expiresAtMs: number;
    }>;
};
export declare function indexPluginNodeCapabilitySurfaces(surfaces: readonly PluginNodeCapabilitySurface[]): Record<string, PluginNodeCapabilitySurface>;
export type NormalizedPluginNodeCapabilityUrl = {
    pathname: string;
    capability?: string;
    rewrittenUrl?: string;
    scopedPath: boolean;
    malformedScopedPath: boolean;
};
export declare function resolvePluginNodeCapabilityTtlMs(surface: PluginNodeCapabilitySurface): number;
export declare function mintPluginNodeCapabilityToken(): string;
export declare function buildPluginNodeCapabilityScopedHostUrl(baseUrl: string, capability: string): string | undefined;
export declare function replacePluginNodeCapabilityInScopedHostUrl(scopedUrl: string, capability: string): string | undefined;
export declare function normalizePluginNodeCapabilityScopedUrl(rawUrl: string): NormalizedPluginNodeCapabilityUrl;
export declare function setClientPluginNodeCapability(params: {
    client: PluginNodeCapabilityClient;
    surface: PluginNodeCapabilitySurface;
    capability: string;
    expiresAtMs: number;
}): void;
export declare function refreshClientPluginNodeCapability(params: {
    client: PluginNodeCapabilityClient;
    surface: PluginNodeCapabilitySurface;
    nowMs?: number;
}): {
    surface: string;
    capability: string;
    expiresAtMs: number;
    scopedUrl: string;
} | undefined;
export declare function hasAuthorizedPluginNodeCapability(params: {
    clients: Iterable<PluginNodeCapabilityClient>;
    surface: PluginNodeCapabilitySurface;
    capability: string;
    nowMs?: number;
}): boolean;
