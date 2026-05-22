import { s as ModelDefinitionConfig } from "./types.models-tqxsISRc.js";
import { t as ConfiguredModelProviderRequest } from "./types.provider-request-C3q5IfeY.js";
import { n as RuntimeVersionEnv } from "./version-C1kCd9e0.js";
import { Api } from "@earendil-works/pi-ai";

//#region src/agents/provider-attribution.d.ts
type ProviderAttributionVerification = "vendor-documented" | "vendor-hidden-api-spec" | "vendor-sdk-hook-only" | "internal-runtime";
type ProviderAttributionHook = "request-headers" | "default-headers" | "user-agent-extra" | "custom-user-agent";
type ProviderAttributionPolicy = {
  provider: string;
  enabledByDefault: boolean;
  verification: ProviderAttributionVerification;
  hook?: ProviderAttributionHook;
  docsUrl?: string;
  reviewNote?: string;
  product: string;
  version: string;
  headers?: Record<string, string>;
};
type ProviderRequestTransport = "stream" | "websocket" | "http" | "media-understanding";
type ProviderRequestCapability = "llm" | "audio" | "image" | "video" | "other";
type ProviderEndpointClass = "default" | "anthropic-public" | "cerebras-native" | "chutes-native" | "deepseek-native" | "github-copilot-native" | "groq-native" | "mistral-public" | "moonshot-native" | "modelstudio-native" | "nvidia-native" | "openai-public" | "openai-codex" | "opencode-native" | "azure-openai" | "openrouter" | "xai-native" | "xiaomi-native" | "zai-native" | "google-generative-ai" | "google-vertex" | "local" | "custom" | "invalid";
type ProviderEndpointResolution = {
  endpointClass: ProviderEndpointClass;
  hostname?: string;
  googleVertexRegion?: string;
};
type ProviderRequestPolicyInput = {
  provider?: string | null;
  api?: string | null;
  baseUrl?: string | null;
  transport?: ProviderRequestTransport;
  capability?: ProviderRequestCapability;
};
type ProviderRequestPolicyResolution = {
  provider?: string;
  policy?: ProviderAttributionPolicy;
  endpointClass: ProviderEndpointClass;
  usesConfiguredBaseUrl: boolean;
  knownProviderFamily: string;
  attributionProvider?: string;
  attributionHeaders?: Record<string, string>;
  allowsHiddenAttribution: boolean;
  usesKnownNativeOpenAIEndpoint: boolean;
  usesKnownNativeOpenAIRoute: boolean;
  usesVerifiedOpenAIAttributionHost: boolean;
  usesExplicitProxyLikeEndpoint: boolean;
};
type ProviderRequestCapabilitiesInput = ProviderRequestPolicyInput & {
  modelId?: string | null;
  compat?: unknown;
};
type ProviderRequestCompatibilityFamily = "moonshot";
type ProviderRequestCapabilities = ProviderRequestPolicyResolution & {
  isKnownNativeEndpoint: boolean;
  allowsOpenAIServiceTier: boolean;
  supportsOpenAIReasoningCompatPayload: boolean;
  allowsAnthropicServiceTier: boolean;
  supportsResponsesStoreField: boolean;
  allowsResponsesStore: boolean;
  shouldStripResponsesPromptCache: boolean;
  supportsNativeStreamingUsageCompat: boolean;
  supportsOpenAICompletionsStreamingUsageCompat: boolean;
  compatibilityFamily?: ProviderRequestCompatibilityFamily;
};
declare function resolveProviderEndpoint(baseUrl: string | null | undefined): ProviderEndpointResolution;
declare function resolveProviderRequestPolicy(input: ProviderRequestPolicyInput, env?: RuntimeVersionEnv): ProviderRequestPolicyResolution;
declare function resolveProviderRequestCapabilities(input: ProviderRequestCapabilitiesInput, env?: RuntimeVersionEnv): ProviderRequestCapabilities;
//#endregion
//#region src/agents/provider-request-config.d.ts
type RequestApi = Api | ModelDefinitionConfig["api"];
type ProviderRequestAuthOverride = {
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
type ProviderRequestTlsOverride = {
  ca?: string;
  cert?: string;
  key?: string;
  passphrase?: string;
  serverName?: string;
  insecureSkipVerify?: boolean;
};
type ProviderRequestProxyOverride = {
  mode: "env-proxy";
  tls?: ProviderRequestTlsOverride;
} | {
  mode: "explicit-proxy";
  url: string;
  tls?: ProviderRequestTlsOverride;
};
type ProviderRequestTransportOverrides = {
  headers?: Record<string, string>;
  auth?: ProviderRequestAuthOverride;
  proxy?: ProviderRequestProxyOverride;
  tls?: ProviderRequestTlsOverride;
};
type ModelProviderRequestTransportOverrides = ProviderRequestTransportOverrides & {
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
type ResolvedProviderRequestConfig = {
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
declare function sanitizeConfiguredModelProviderRequest(request: ConfiguredModelProviderRequest | undefined): ModelProviderRequestTransportOverrides | undefined;
declare function normalizeBaseUrl(baseUrl: string | undefined, fallback: string): string;
declare function normalizeBaseUrl(baseUrl: string | undefined, fallback?: string): string | undefined;
declare function resolveProviderRequestHeaders(params: {
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
//#endregion
export { resolveProviderRequestPolicy as S, ProviderRequestPolicyInput as _, ProviderRequestTransportOverrides as a, resolveProviderEndpoint as b, resolveProviderRequestHeaders as c, ProviderEndpointClass as d, ProviderEndpointResolution as f, ProviderRequestCompatibilityFamily as g, ProviderRequestCapability as h, ProviderRequestTlsOverride as i, sanitizeConfiguredModelProviderRequest as l, ProviderRequestCapabilitiesInput as m, ProviderRequestAuthOverride as n, ResolvedProviderRequestConfig as o, ProviderRequestCapabilities as p, ProviderRequestProxyOverride as r, normalizeBaseUrl as s, ModelProviderRequestTransportOverrides as t, ProviderAttributionPolicy as u, ProviderRequestPolicyResolution as v, resolveProviderRequestCapabilities as x, ProviderRequestTransport as y };