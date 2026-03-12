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
export declare function isLocalGatewayAddress(ip: string | undefined): boolean;
/**
 * Resolves gateway bind host with fallback strategy.
 *
 * Modes:
 * - loopback: 127.0.0.1 (rarely fails, but handled gracefully)
 * - lan: always 0.0.0.0 (no fallback)
 * - tailnet: Tailnet IPv4 if available, else loopback
 * - auto: Loopback if available, else 0.0.0.0
 * - custom: User-specified IP, fallback to 0.0.0.0 if unavailable
 *
 * @returns The bind address to use (never null)
 */
export declare function resolveGatewayBindHost(bind: import("../config/config.js").GatewayBindMode | undefined, customHost?: string): Promise<string>;
/**
 * Test if we can bind to a specific host address.
 * Creates a temporary server, attempts to bind, then closes it.
 *
 * @param host - The host address to test
 * @returns True if we can successfully bind to this address
 */
export declare function canBindToHost(host: string): Promise<boolean>;
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
 * Security check for WebSocket URLs (CWE-319: Cleartext Transmission of Sensitive Information).
 *
 * Returns true if the URL is secure for transmitting data:
 * - wss:// (TLS) is always secure
 * - ws:// is only secure for loopback addresses (localhost, 127.x.x.x, ::1)
 *
 * All other ws:// URLs are considered insecure because both credentials
 * AND chat/conversation data would be exposed to network interception.
 */
export declare function isSecureWebSocketUrl(url: string): boolean;
