import ipaddr from "ipaddr.js";
export type ParsedIpAddress = ipaddr.IPv4 | ipaddr.IPv6;
export type Ipv4SpecialUseBlockOptions = {
    allowRfc2544BenchmarkRange?: boolean;
};
/**
 * Per-call exemptions for `isBlockedSpecialUseIpv6Address`. Mirror of
 * {@link Ipv4SpecialUseBlockOptions} for the IPv6 side. Currently only
 * `allowUniqueLocalRange` is exposed (#74351); other reserved IPv6 ranges stay
 * unconditionally blocked because they have no documented fake-ip / proxy
 * use case.
 */
export type Ipv6SpecialUseBlockOptions = {
    /**
     * When true, exempt addresses in `fc00::/7` (the IPv6 Unique Local Address
     * block, RFC 4193) from the SSRF private-IP block. Sing-box / Clash / Surge
     * fake-ip implementations resolve foreign domains to ULA addresses
     * alongside RFC 2544 benchmark IPv4 addresses, and operators using those
     * proxy stacks need both ranges exempted to keep `web_fetch` working.
     */
    allowUniqueLocalRange?: boolean;
};
export declare function isIpv4Address(address: ParsedIpAddress): address is ipaddr.IPv4;
export declare function isIpv6Address(address: ParsedIpAddress): address is ipaddr.IPv6;
export declare function parseCanonicalIpAddress(raw: string | undefined): ParsedIpAddress | undefined;
export declare function parseLooseIpAddress(raw: string | undefined): ParsedIpAddress | undefined;
export declare function normalizeIpAddress(raw: string | undefined): string | undefined;
export declare function isCanonicalDottedDecimalIPv4(raw: string | undefined): boolean;
export declare function isLegacyIpv4Literal(raw: string | undefined): boolean;
export declare function isLoopbackIpAddress(raw: string | undefined): boolean;
export declare function isPrivateOrLoopbackIpAddress(raw: string | undefined): boolean;
export declare function isBlockedSpecialUseIpv6Address(address: ipaddr.IPv6, options?: Ipv6SpecialUseBlockOptions): boolean;
export declare function isRfc1918Ipv4Address(raw: string | undefined): boolean;
export declare function isCarrierGradeNatIpv4Address(raw: string | undefined): boolean;
export declare function isBlockedSpecialUseIpv4Address(address: ipaddr.IPv4, options?: Ipv4SpecialUseBlockOptions): boolean;
export declare function extractEmbeddedIpv4FromIpv6(address: ipaddr.IPv6): ipaddr.IPv4 | undefined;
export declare function isIpInCidr(ip: string, cidr: string): boolean;
