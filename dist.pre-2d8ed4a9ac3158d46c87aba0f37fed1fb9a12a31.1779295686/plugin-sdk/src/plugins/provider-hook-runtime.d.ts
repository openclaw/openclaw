import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ProviderPlugin, ProviderExtraParamsForTransportContext, ProviderPrepareExtraParamsContext, ProviderResolveAuthProfileIdContext, ProviderFollowupFallbackRouteContext, ProviderFollowupFallbackRouteResult, ProviderWrapStreamFnContext } from "./types.js";
export type ProviderRuntimePluginLookupParams = {
    provider: string;
    config?: OpenClawConfig;
    workspaceDir?: string;
    env?: NodeJS.ProcessEnv;
    applyAutoEnable?: boolean;
    bundledProviderAllowlistCompat?: boolean;
    bundledProviderVitestCompat?: boolean;
};
export type ProviderRuntimePluginHandle = ProviderRuntimePluginLookupParams & {
    plugin?: ProviderPlugin;
};
export type ProviderRuntimePluginHandleParams = ProviderRuntimePluginLookupParams & {
    runtimeHandle?: ProviderRuntimePluginHandle;
};
export declare function resolveProviderPluginsForHooks(params: {
    config?: OpenClawConfig;
    workspaceDir?: string;
    env?: NodeJS.ProcessEnv;
    onlyPluginIds?: string[];
    providerRefs?: readonly string[];
    applyAutoEnable?: boolean;
    bundledProviderAllowlistCompat?: boolean;
    bundledProviderVitestCompat?: boolean;
}): ProviderPlugin[];
export declare function resolveProviderRuntimePlugin(params: ProviderRuntimePluginLookupParams): ProviderPlugin | undefined;
export declare function resolveLoadedProviderRuntimePlugin(params: ProviderRuntimePluginLookupParams): ProviderPlugin | undefined;
export declare function resolveProviderHookPlugin(params: {
    provider: string;
    config?: OpenClawConfig;
    workspaceDir?: string;
    env?: NodeJS.ProcessEnv;
}): ProviderPlugin | undefined;
export declare function resolveProviderRuntimePluginHandle(params: ProviderRuntimePluginLookupParams): ProviderRuntimePluginHandle;
export declare function ensureProviderRuntimePluginHandle(params: ProviderRuntimePluginHandleParams): ProviderRuntimePluginHandle;
export declare function prepareProviderExtraParams(params: {
    provider: string;
    config?: OpenClawConfig;
    workspaceDir?: string;
    env?: NodeJS.ProcessEnv;
    runtimeHandle?: ProviderRuntimePluginHandle;
    context: ProviderPrepareExtraParamsContext;
}): Record<string, unknown> | undefined;
export declare function resolveProviderExtraParamsForTransport(params: {
    provider: string;
    config?: OpenClawConfig;
    workspaceDir?: string;
    env?: NodeJS.ProcessEnv;
    runtimeHandle?: ProviderRuntimePluginHandle;
    context: ProviderExtraParamsForTransportContext;
}): import("./types.js").ProviderExtraParamsForTransportResult | undefined;
export declare function resolveProviderAuthProfileId(params: {
    provider: string;
    config?: OpenClawConfig;
    workspaceDir?: string;
    env?: NodeJS.ProcessEnv;
    runtimeHandle?: ProviderRuntimePluginHandle;
    context: ProviderResolveAuthProfileIdContext;
}): string | undefined;
export declare function resolveProviderFollowupFallbackRoute(params: {
    provider: string;
    config?: OpenClawConfig;
    workspaceDir?: string;
    env?: NodeJS.ProcessEnv;
    runtimeHandle?: ProviderRuntimePluginHandle;
    context: ProviderFollowupFallbackRouteContext;
}): ProviderFollowupFallbackRouteResult | undefined;
export declare function wrapProviderStreamFn(params: {
    provider: string;
    config?: OpenClawConfig;
    workspaceDir?: string;
    env?: NodeJS.ProcessEnv;
    runtimeHandle?: ProviderRuntimePluginHandle;
    context: ProviderWrapStreamFnContext;
}): import("@earendil-works/pi-agent-core").StreamFn | undefined;
