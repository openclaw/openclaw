import type { IncomingMessage } from "node:http";
import type { GatewayBindMode } from "../config/types.gateway.js";
import { __resetContainerEnvironmentCacheForTest, isContainerEnvironment } from "../infra/container-environment.js";
/**
 * Pick the primary non-internal IPv4 address (LAN IP).
 * Prefers common interface names (en0, eth0) then falls back to any external IPv4.
 */
export declare function pickPrimaryLanIPv4(): string | undefined;
export declare function normalizeHostHeader(hostHeader?: string): string;
export declare function resolveHostName(hostHeader?: string): string;
export declare function isLoopbackAddress(ip: string | undefined): boolean;
/**
 * Returns true if the IP belongs to a private or loopback network range.
 * Private ranges: RFC1918, link-local, ULA IPv6, and CGNAT (100.64/10), plus loopback.
 */
export declare function isPrivateOrLoopbackAddress(ip: string | undefined): boolean;
export declare function isTrustedProxyAddress(ip: string | undefined, trustedProxies?: string[]): boolean;
export declare function resolveClientIp(params: {
    remoteAddr?: string;
    forwardedFor?: string;
    realIp?: string;
    trustedProxies?: string[];
    /** Default false: only trust X-Real-IP when explicitly enabled. */
    allowRealIpFallback?: boolean;
}): string | undefined;
export declare function resolveRequestClientIp(req?: IncomingMessage, trustedProxies?: string[], allowRealIpFallback?: boolean): string | undefined;
export { isContainerEnvironment, __resetContainerEnvironmentCacheForTest as __resetContainerCacheForTest, };
/**
 * Resolves gateway bind host with fallback strategy.
 *
 * Modes:
 * - loopback: 127.0.0.1 (rarely fails, but handled gracefully)
 * - lan: always 0.0.0.0 (no fallback)
 * - tailnet: Tailnet IPv4 if available, else loopback
 * - auto: 0.0.0.0 inside containers (Docker/Podman/K8s); loopback otherwise
 * - custom: User-specified IP, fallback to 0.0.0.0 if unavailable
 *
 * @returns The bind address to use (never null)
 */
export declare function resolveGatewayBindHost(bind: GatewayBindMode | undefined, customHost?: string): Promise<string>;
/**
 * Returns the effective default bind mode when `gateway.bind` is not explicitly
 * configured. Inside a detected container environment the default is `"auto"`
 * (which resolves to `0.0.0.0` for port-forwarding compatibility); on bare-metal
 * / VM hosts the default remains `"loopback"`.
 *
 * When {@link tailscaleMode} is `"serve"` or `"funnel"`, the function always
 * returns `"loopback"` because Tailscale serve/funnel architecturally requires
 * a loopback bind — container auto-detection must never override this.
 *
 * Use this only in gateway startup codepaths that execute in the same
 * environment as the eventual bind decision. Host-side diagnostics should keep
 * their own explicit defaults instead of inferring from the caller process.
 */
export declare function defaultGatewayBindMode(tailscaleMode?: string): GatewayBindMode;
export declare function resolveGatewayListenHosts(bindHost: string, opts?: {
    canBindToHost?: (host: string) => Promise<boolean>;
}): Promise<string[]>;
/**
 * Validate if a string is a valid IPv4 address.
 *
 * @param host - The string to validate
 * @returns True if valid IPv4 format
 */
export declare function isValidIPv4(host: string): boolean;
/**
 * Check if a hostname or IP refers to the local machine.
 * Handles: localhost, 127.x.x.x, ::1, [::1], ::ffff:127.x.x.x
 * Note: 0.0.0.0 and :: are NOT loopback - they bind to all interfaces.
 */
export declare function isLoopbackHost(host: string): boolean;
/**
 * Local-facing host check for inbound requests:
 * - loopback hosts (localhost/127.x/::1 and mapped forms)
 * - Tailscale Serve/Funnel hostnames (*.ts.net)
 */
export declare function isLocalishHost(hostHeader?: string): boolean;
/**
 * Check if a hostname or IP refers to a private or loopback address.
 * Handles the same hostname formats as isLoopbackHost, but also accepts
 * RFC 1918, link-local, CGNAT, and IPv6 ULA/link-local addresses.
 */
export declare function isPrivateOrLoopbackHost(host: string): boolean;
/**
 * Security check for WebSocket URLs (CWE-319: Cleartext Transmission of Sensitive Information).
 *
 * Returns true if the URL is secure for transmitting data:
 * - wss:// (TLS) is always secure
 * - ws:// is secure only for loopback addresses by default
 * - optional break-glass: private ws:// can be enabled for trusted networks
 *
 * All other ws:// URLs are considered insecure because both credentials
 * AND chat/conversation data would be exposed to network interception.
 */
export declare function isSecureWebSocketUrl(url: string, opts?: {
    allowPrivateWs?: boolean;
}): boolean;
