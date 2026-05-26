//#region src/infra/net/proxy-env.d.ts
declare const PROXY_ENV_KEYS: readonly ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"];
declare function hasProxyEnvConfigured(env?: NodeJS.ProcessEnv): boolean;
type EnvHttpProxyAgentProxyOptions = {
  httpProxy?: string;
  httpsProxy?: string;
};
/**
 * Match undici EnvHttpProxyAgent semantics for env-based HTTP/S proxy selection:
 * - lower-case vars take precedence over upper-case
 * - HTTPS requests prefer https_proxy/HTTPS_PROXY, then fall back to http_proxy/HTTP_PROXY
 * - ALL_PROXY is ignored by EnvHttpProxyAgent
 */
declare function resolveEnvHttpProxyUrl(protocol: "http" | "https", env?: NodeJS.ProcessEnv): string | undefined;
declare function hasEnvHttpProxyConfigured(protocol?: "http" | "https", env?: NodeJS.ProcessEnv): boolean;
/**
 * Build explicit options for undici's EnvHttpProxyAgent.
 *
 * EnvHttpProxyAgent does not read ALL_PROXY itself, but it accepts explicit
 * HTTP/HTTPS proxy overrides. Keep this helper separate from the
 * HTTP(S)-only URL helpers so SSRF trusted-env proxy gates do not widen.
 */
declare function resolveEnvHttpProxyAgentOptions(env?: NodeJS.ProcessEnv): EnvHttpProxyAgentProxyOptions | undefined;
declare function hasEnvHttpProxyAgentConfigured(env?: NodeJS.ProcessEnv): boolean;
declare function shouldUseEnvHttpProxyForUrl(targetUrl: string, env?: NodeJS.ProcessEnv): boolean;
/**
 * Check whether a target URL should bypass the HTTP proxy per NO_PROXY env var.
 *
 * Mirrors undici EnvHttpProxyAgent semantics
 * (`undici/lib/dispatcher/env-http-proxy-agent.js`):
 * - Entries separated by commas OR whitespace (undici splits on `/[,\s]/`)
 * - Case-insensitive
 * - Empty or missing → no bypass
 * - Bare `*` value → bypass everything
 * - Exact hostname match
 * - Leading-dot match (`.example.com` matches `foo.example.com`)
 * - Leading `*.` wildcard match (`*.example.com` matches `foo.example.com`);
 *   undici normalizes via `.replace(/^\*?\./, '')`, so the bare domain also
 *   matches (kept in sync with that behavior)
 * - Subdomain suffix match (`openai.com` matches `api.openai.com`)
 * - Optional `:port` suffix; when present, must match target port
 * - IPv6 literals in bracketed form (`[::1]`)
 * - OpenClaw extension: IPv4 CIDR and octet-wildcard entries
 *   (`100.64.0.0/10`, `100.64.*`) bypass the trusted env proxy mode before
 *   undici's EnvHttpProxyAgent is selected.
 *
 * Undici does not export its matcher, so this is a targeted reimplementation
 * kept in sync with the upstream file above. Paired with
 * `hasEnvHttpProxyConfigured` this gates the trusted-env-proxy auto-upgrade
 * in provider HTTP helpers; see openclaw#64974 review thread on NO_PROXY
 * SSRF bypass.
 */
declare function matchesNoProxy(targetUrl: string, env?: NodeJS.ProcessEnv): boolean;
//#endregion
export { hasProxyEnvConfigured as a, resolveEnvHttpProxyUrl as c, hasEnvHttpProxyConfigured as i, shouldUseEnvHttpProxyForUrl as l, PROXY_ENV_KEYS as n, matchesNoProxy as o, hasEnvHttpProxyAgentConfigured as r, resolveEnvHttpProxyAgentOptions as s, EnvHttpProxyAgentProxyOptions as t };