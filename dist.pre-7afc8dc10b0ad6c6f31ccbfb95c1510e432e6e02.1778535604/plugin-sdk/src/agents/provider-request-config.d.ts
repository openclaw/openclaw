import type { Api } from "@mariozechner/pi-ai";
import type { ModelDefinitionConfig } from "../config/types.js";
import type { ConfiguredModelProviderRequest, ConfiguredProviderRequest } from "../config/types.provider-request.js";
import type { PinnedDispatcherPolicy } from "../infra/net/ssrf.js";
import type { ProviderRequestCapabilities, ProviderRequestCapability, ProviderRequestTransport } from "./provider-attribution.js";
import { type ProviderRequestPolicyResolution } from "./provider-attribution.js";
type RequestApi = Api | ModelDefinitionConfig["api"];
export type ProviderRequestAuthOverride = {
    mode: "provider-default";
} | {
    mode: "authorization-bearer";
    token: string;
} | {
    mode: "header";
    headerName: string;
    value: string;
    prefix?: string;
};
export type ProviderRequestTlsOverride = {
    ca?: string;
    cert?: string;
    key?: string;
    passphrase?: string;
    serverName?: string;
    insecureSkipVerify?: boolean;
};
export type ProviderRequestProxyOverride = {
    mode: "env-proxy";
    tls?: ProviderRequestTlsOverride;
} | {
    mode: "explicit-proxy";
    url: string;
    tls?: ProviderRequestTlsOverride;
};
export type ProviderRequestTransportOverrides = {
    headers?: Record<string, string>;
    auth?: ProviderRequestAuthOverride;
    proxy?: ProviderRequestProxyOverride;
    tls?: ProviderRequestTlsOverride;
};
export type ModelProviderRequestTransportOverrides = ProviderRequestTransportOverrides & {
    allowPrivateNetwork?: boolean;
};
type ResolvedProviderRequestAuthConfig = {
    configured: false;
    mode: "provider-default" | "authorization-bearer";
    injectAuthorizationHeader: boolean;
} | {
    configured: true;
    mode: "authorization-bearer";
    headerName: "Authorization";
    value: string;
    injectAuthorizationHeader: true;
} | {
    configured: true;
    mode: "header";
    headerName: string;
    value: string;
    prefix?: string;
    injectAuthorizationHeader: false;
};
type ResolvedProviderRequestProxyConfig = {
    configured: false;
} | {
    configured: true;
    mode: "env-proxy";
    tls: ResolvedProviderRequestTlsConfig;
} | {
    configured: true;
    mode: "explicit-proxy";
    proxyUrl: string;
    tls: ResolvedProviderRequestTlsConfig;
};
type ResolvedProviderRequestTlsConfig = {
    configured: false;
} | {
    configured: true;
    ca?: string;
    cert?: string;
    key?: string;
    passphrase?: string;
    serverName?: string;
    rejectUnauthorized?: boolean;
};
type ResolvedProviderRequestExtraHeadersConfig = {
    configured: boolean;
    headers?: Record<string, string>;
};
export type ResolvedProviderRequestConfig = {
    api?: RequestApi;
    baseUrl?: string;
    headers?: Record<string, string>;
    extraHeaders: ResolvedProviderRequestExtraHeadersConfig;
    auth: ResolvedProviderRequestAuthConfig;
    proxy: ResolvedProviderRequestProxyConfig;
    tls: ResolvedProviderRequestTlsConfig;
    policy: ProviderRequestPolicyResolution;
};
type ProviderRequestHeaderPrecedence = "caller-wins" | "defaults-win";
type ResolvedProviderRequestPolicyConfig = ResolvedProviderRequestConfig & {
    allowPrivateNetwork: boolean;
    capabilities: ProviderRequestCapabilities;
};
type ResolveProviderRequestPolicyConfigParams = {
    provider?: string;
    api?: RequestApi;
    baseUrl?: string;
    defaultBaseUrl?: string;
    capability?: ProviderRequestCapability;
    transport?: ProviderRequestTransport;
    discoveredHeaders?: Record<string, string>;
    providerHeaders?: Record<string, string>;
    modelHeaders?: Record<string, string>;
    callerHeaders?: Record<string, string>;
    precedence?: ProviderRequestHeaderPrecedence;
    authHeader?: boolean;
    compat?: unknown;
    modelId?: string | null;
    allowPrivateNetwork?: boolean;
    request?: ModelProviderRequestTransportOverrides;
};
export declare function sanitizeConfiguredProviderRequest(request: ConfiguredProviderRequest | undefined): ProviderRequestTransportOverrides | undefined;
export declare function sanitizeConfiguredModelProviderRequest(request: ConfiguredModelProviderRequest | undefined): ModelProviderRequestTransportOverrides | undefined;
export declare function mergeProviderRequestOverrides(...overrides: Array<ProviderRequestTransportOverrides | undefined>): ProviderRequestTransportOverrides | undefined;
export declare function mergeModelProviderRequestOverrides(...overrides: Array<ModelProviderRequestTransportOverrides | undefined>): ModelProviderRequestTransportOverrides | undefined;
export declare function normalizeBaseUrl(baseUrl: string | undefined, fallback: string): string;
export declare function normalizeBaseUrl(baseUrl: string | undefined, fallback?: string): string | undefined;
export declare function sanitizeRuntimeProviderRequestOverrides(request: ProviderRequestTransportOverrides | undefined): ProviderRequestTransportOverrides | undefined;
export declare function buildProviderRequestDispatcherPolicy(request: Pick<ResolvedProviderRequestConfig, "proxy" | "tls">): PinnedDispatcherPolicy | undefined;
export declare function buildProviderRequestTlsClientOptions(request: Pick<ResolvedProviderRequestConfig, "tls">): Record<string, unknown> | undefined;
export declare function resolveProviderRequestPolicyConfig(params: ResolveProviderRequestPolicyConfigParams): ResolvedProviderRequestPolicyConfig;
export declare function resolveProviderRequestConfig(params: {
    provider: string;
    api?: RequestApi;
    baseUrl?: string;
    capability?: ProviderRequestCapability;
    transport?: ProviderRequestTransport;
    discoveredHeaders?: Record<string, string>;
    providerHeaders?: Record<string, string>;
    modelHeaders?: Record<string, string>;
    authHeader?: boolean;
    request?: ProviderRequestTransportOverrides;
}): ResolvedProviderRequestConfig;
export declare function resolveProviderRequestHeaders(params: {
    provider: string;
    api?: RequestApi;
    baseUrl?: string;
    capability?: ProviderRequestCapability;
    transport?: ProviderRequestTransport;
    callerHeaders?: Record<string, string>;
    defaultHeaders?: Record<string, string>;
    precedence?: ProviderRequestHeaderPrecedence;
    request?: ProviderRequestTransportOverrides;
}): Record<string, string> | undefined;
export declare function attachModelProviderRequestTransport<TModel extends object>(model: TModel, request: ModelProviderRequestTransportOverrides | undefined): TModel;
export declare function getModelProviderRequestTransport(model: object): ModelProviderRequestTransportOverrides | undefined;
export {};
