import { lookup as dnsLookupCb } from "node:dns";
import { lookup as dnsLookup } from "node:dns/promises";
import { type Dispatcher } from "undici";
export declare class SsrFBlockedError extends Error {
    constructor(message: string);
}
export type LookupFn = typeof dnsLookup;
export type SsrFPolicy = {
    allowPrivateNetwork?: boolean;
    dangerouslyAllowPrivateNetwork?: boolean;
    allowRfc2544BenchmarkRange?: boolean;
    allowedHostnames?: string[];
    hostnameAllowlist?: string[];
};
export declare function isPrivateIpAddress(address: string, policy?: SsrFPolicy): boolean;
export declare function isBlockedHostname(hostname: string): boolean;
export declare function isBlockedHostnameOrIp(hostname: string, policy?: SsrFPolicy): boolean;
export declare function createPinnedLookup(params: {
    hostname: string;
    addresses: string[];
    fallback?: typeof dnsLookupCb;
}): typeof dnsLookupCb;
export type PinnedHostname = {
    hostname: string;
    addresses: string[];
    lookup: typeof dnsLookupCb;
};
export declare function resolvePinnedHostnameWithPolicy(hostname: string, params?: {
    lookupFn?: LookupFn;
    policy?: SsrFPolicy;
}): Promise<PinnedHostname>;
export declare function resolvePinnedHostname(hostname: string, lookupFn?: LookupFn): Promise<PinnedHostname>;
export declare function createPinnedDispatcher(pinned: PinnedHostname): Dispatcher;
export declare function closeDispatcher(dispatcher?: Dispatcher | null): Promise<void>;
export declare function assertPublicHostname(hostname: string, lookupFn?: LookupFn): Promise<void>;
