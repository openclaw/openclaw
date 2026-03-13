/**
 * Proxy bypass for CDP (Chrome DevTools Protocol) localhost connections.
 *
 * When HTTP_PROXY / HTTPS_PROXY / ALL_PROXY environment variables are set,
 * CDP connections to localhost/127.0.0.1 can be incorrectly routed through
 * the proxy, causing browser control to fail.
 *
 * @see https://github.com/nicepkg/openclaw/issues/31219
 */
import http from "node:http";
import https from "node:https";
/**
 * Returns a plain (non-proxy) agent for WebSocket or HTTP connections
 * when the target is a loopback address. Returns `undefined` otherwise
 * so callers fall through to their default behaviour.
 */
export declare function getDirectAgentForCdp(url: string): http.Agent | https.Agent | undefined;
/**
 * Returns `true` when any proxy-related env var is set that could
 * interfere with loopback connections.
 */
export declare function hasProxyEnv(): boolean;
export declare function withNoProxyForLocalhost<T>(fn: () => Promise<T>): Promise<T>;
/**
 * Scoped NO_PROXY bypass for loopback CDP URLs.
 *
 * This wrapper only mutates env vars for loopback destinations. On restore,
 * it avoids clobbering external NO_PROXY changes that happened while calls
 * were in-flight.
 */
export declare function withNoProxyForCdpUrl<T>(url: string, fn: () => Promise<T>): Promise<T>;
