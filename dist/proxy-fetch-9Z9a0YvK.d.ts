//#region src/infra/fetch.d.ts
declare function wrapFetchWithAbortSignal(fetchImpl: typeof fetch): typeof fetch;
declare function resolveFetch(fetchImpl?: typeof fetch): typeof fetch | undefined;
//#endregion
//#region src/infra/net/proxy-fetch.d.ts
declare const PROXY_FETCH_PROXY_URL: unique symbol;
/**
 * Create a fetch function that routes requests through the given HTTP proxy.
 * Uses undici's ProxyAgent under the hood.
 */
declare function makeProxyFetch(proxyUrl: string): typeof fetch;
declare function getProxyUrlFromFetch(fetchImpl?: typeof fetch): string | undefined;
/**
 * Resolve a proxy-aware fetch from standard environment variables.
 * Respects NO_PROXY / no_proxy exclusions via undici's EnvHttpProxyAgent.
 * Returns undefined when no proxy is configured.
 * Gracefully returns undefined if the proxy URL is malformed.
 */
declare function resolveProxyFetchFromEnv(env?: NodeJS.ProcessEnv): typeof fetch | undefined;
//#endregion
export { resolveFetch as a, resolveProxyFetchFromEnv as i, getProxyUrlFromFetch as n, wrapFetchWithAbortSignal as o, makeProxyFetch as r, PROXY_FETCH_PROXY_URL as t };