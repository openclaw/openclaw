import { lookup } from "node:dns";
import { lookup as lookup$1 } from "node:dns/promises";
import { Dispatcher } from "undici";

//#region src/infra/net/ssrf.d.ts
declare class SsrFBlockedError extends Error {
  constructor(message: string);
}
type LookupFn = typeof lookup$1;
type SsrFPolicy = {
  allowPrivateNetwork?: boolean;
  dangerouslyAllowPrivateNetwork?: boolean;
  allowRfc2544BenchmarkRange?: boolean;
  /**
   * Exempt addresses in `fc00::/7` (IPv6 Unique Local Address block, RFC 4193)
   * from the SSRF private-IP block. Companion to
   * `allowRfc2544BenchmarkRange` for fake-ip proxy stacks (sing-box, Clash,
   * Surge) that resolve foreign domains to ULA addresses alongside the IPv4
   * 198.18.0.0/15 range. See #74351.
   */
  allowIpv6UniqueLocalRange?: boolean;
  allowedHostnames?: string[];
  /**
   * Exact HTTP origins that may promote only the current request hostname into
   * `allowedHostnames`. Evaluated per URL inside the redirect loop.
   */
  allowedOrigins?: string[];
  hostnameAllowlist?: string[];
};
declare function isSameSsrFPolicy(a?: SsrFPolicy, b?: SsrFPolicy): boolean;
declare function mergeSsrFPolicies(...policies: Array<SsrFPolicy | undefined>): SsrFPolicy | undefined;
declare function ssrfPolicyFromHttpBaseUrlAllowedHostname(baseUrl: string): SsrFPolicy | undefined;
declare function ssrfPolicyFromHttpBaseUrlAllowedOrigin(baseUrl: string): SsrFPolicy | undefined;
declare function ssrfPolicyFromHttpBaseUrlFakeIpHostnameAllowlist(baseUrl: string): SsrFPolicy | undefined;
declare function normalizeHostnameAllowlist(values?: string[]): string[];
declare function isPrivateNetworkAllowedByPolicy(policy?: SsrFPolicy): boolean;
declare function resolveSsrFPolicyForUrl(url: URL, policy?: SsrFPolicy): SsrFPolicy | undefined;
declare function isHostnameAllowedByPattern(hostname: string, pattern: string): boolean;
declare function matchesHostnameAllowlist(hostname: string, allowlist: string[]): boolean;
declare function isPrivateIpAddress(address: string, policy?: SsrFPolicy): boolean;
declare function isBlockedHostname(hostname: string): boolean;
declare function isBlockedHostnameOrIp(hostname: string, policy?: SsrFPolicy): boolean;
declare function createPinnedLookup(params: {
  hostname: string;
  addresses: string[];
  fallback?: typeof lookup;
}): typeof lookup;
type PinnedHostname = {
  hostname: string;
  addresses: string[];
  lookup: typeof lookup;
};
type PinnedHostnameOverride = {
  hostname: string;
  addresses: string[];
};
type PinnedDispatcherPolicy = {
  mode: "direct";
  connect?: Record<string, unknown>;
  pinnedHostname?: PinnedHostnameOverride;
} | {
  mode: "env-proxy";
  connect?: Record<string, unknown>;
  proxyTls?: Record<string, unknown>;
  pinnedHostname?: PinnedHostnameOverride;
} | {
  mode: "explicit-proxy";
  proxyUrl: string;
  allowPrivateProxy?: boolean;
  proxyTls?: Record<string, unknown>;
  pinnedHostname?: PinnedHostnameOverride;
};
declare function resolvePinnedHostnameWithPolicy(hostname: string, params?: {
  lookupFn?: LookupFn;
  policy?: SsrFPolicy;
}): Promise<PinnedHostname>;
declare function assertHostnameAllowedWithPolicy(hostname: string, policy?: SsrFPolicy): string;
declare function resolvePinnedHostname(hostname: string, lookupFn?: LookupFn): Promise<PinnedHostname>;
declare function createPinnedDispatcher(pinned: PinnedHostname, policy?: PinnedDispatcherPolicy, ssrfPolicy?: SsrFPolicy, timeoutMs?: number): Dispatcher;
declare function closeDispatcher(dispatcher?: Dispatcher | null): Promise<void>;
declare function assertPublicHostname(hostname: string, lookupFn?: LookupFn): Promise<void>;
//#endregion
export { resolveSsrFPolicyForUrl as C, ssrfPolicyFromHttpBaseUrlFakeIpHostnameAllowlist as E, resolvePinnedHostnameWithPolicy as S, ssrfPolicyFromHttpBaseUrlAllowedOrigin as T, isSameSsrFPolicy as _, SsrFBlockedError as a, normalizeHostnameAllowlist as b, assertPublicHostname as c, createPinnedLookup as d, isBlockedHostname as f, isPrivateNetworkAllowedByPolicy as g, isPrivateIpAddress as h, PinnedHostnameOverride as i, closeDispatcher as l, isHostnameAllowedByPattern as m, PinnedDispatcherPolicy as n, SsrFPolicy as o, isBlockedHostnameOrIp as p, PinnedHostname as r, assertHostnameAllowedWithPolicy as s, LookupFn as t, createPinnedDispatcher as u, matchesHostnameAllowlist as v, ssrfPolicyFromHttpBaseUrlAllowedHostname as w, resolvePinnedHostname as x, mergeSsrFPolicies as y };