import { IncomingMessage } from "node:http";

//#region src/gateway/net.d.ts
declare function isTrustedProxyAddress(ip: string | undefined, trustedProxies?: string[]): boolean;
declare function resolveClientIp(params: {
  remoteAddr?: string;
  forwardedFor?: string;
  realIp?: string;
  trustedProxies?: string[]; /** Default false: only trust X-Real-IP when explicitly enabled. */
  allowRealIpFallback?: boolean;
}): string | undefined;
declare function resolveRequestClientIp(req?: IncomingMessage, trustedProxies?: string[], allowRealIpFallback?: boolean): string | undefined;
/**
 * Check if a hostname or IP refers to the local machine.
 * Handles: localhost, 127.x.x.x, ::1, [::1], ::ffff:127.x.x.x
 * Note: 0.0.0.0 and :: are NOT loopback - they bind to all interfaces.
 */
declare function isLoopbackHost(host: string): boolean;
/**
 * Check if a hostname or IP refers to a private or loopback address.
 * Handles the same hostname formats as isLoopbackHost, but also accepts
 * RFC 1918, link-local, CGNAT, and IPv6 ULA/link-local addresses.
 */
declare function isPrivateOrLoopbackHost(host: string): boolean;
//#endregion
export { resolveRequestClientIp as a, resolveClientIp as i, isPrivateOrLoopbackHost as n, isTrustedProxyAddress as r, isLoopbackHost as t };