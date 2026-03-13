export declare const PROXY_ENV_KEYS: readonly ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"];
export declare function hasProxyEnvConfigured(env?: NodeJS.ProcessEnv): boolean;
/**
 * Match undici EnvHttpProxyAgent semantics for env-based HTTP/S proxy selection:
 * - lower-case vars take precedence over upper-case
 * - HTTPS requests prefer https_proxy/HTTPS_PROXY, then fall back to http_proxy/HTTP_PROXY
 * - ALL_PROXY is ignored by EnvHttpProxyAgent
 */
export declare function resolveEnvHttpProxyUrl(protocol: "http" | "https", env?: NodeJS.ProcessEnv): string | undefined;
export declare function hasEnvHttpProxyConfigured(protocol?: "http" | "https", env?: NodeJS.ProcessEnv): boolean;
