import { isPrivateIpAddress, type LookupFn, type SsrFPolicy } from "../infra/net/ssrf.js";
import type { ChannelDoctorConfigMutation, ChannelDoctorLegacyConfigRule } from "./channel-contract.js";
import type { OpenClawConfig } from "./config-runtime.js";
export { isPrivateIpAddress };
export type { SsrFPolicy };
export type PrivateNetworkOptInInput = boolean | null | undefined | Pick<SsrFPolicy, "allowPrivateNetwork" | "dangerouslyAllowPrivateNetwork"> | {
    dangerouslyAllowPrivateNetwork?: boolean | null;
    /** @deprecated Compatibility alias; prefer dangerouslyAllowPrivateNetwork. */
    allowPrivateNetwork?: boolean | null;
    network?: Pick<SsrFPolicy, "allowPrivateNetwork" | "dangerouslyAllowPrivateNetwork"> | null | undefined;
};
export declare function isPrivateNetworkOptInEnabled(input: PrivateNetworkOptInInput): boolean;
export declare function ssrfPolicyFromPrivateNetworkOptIn(input: PrivateNetworkOptInInput): SsrFPolicy | undefined;
export declare function ssrfPolicyFromDangerouslyAllowPrivateNetwork(dangerouslyAllowPrivateNetwork: boolean | null | undefined): SsrFPolicy | undefined;
export declare function mergeSsrFPolicies(...policies: Array<SsrFPolicy | undefined>): SsrFPolicy | undefined;
export declare function hasLegacyFlatAllowPrivateNetworkAlias(value: unknown): boolean;
export declare function migrateLegacyFlatAllowPrivateNetworkAlias(params: {
    entry: Record<string, unknown>;
    pathPrefix: string;
    changes: string[];
}): {
    entry: Record<string, unknown>;
    changed: boolean;
};
export declare function createLegacyPrivateNetworkDoctorContract(params: {
    channelKey: string;
}): {
    legacyConfigRules: ChannelDoctorLegacyConfigRule[];
    normalizeCompatibilityConfig: (params: {
        cfg: OpenClawConfig;
    }) => ChannelDoctorConfigMutation;
};
export declare function ssrfPolicyFromAllowPrivateNetwork(allowPrivateNetwork: boolean | null | undefined): SsrFPolicy | undefined;
export declare function assertHttpUrlTargetsPrivateNetwork(url: string, params?: {
    dangerouslyAllowPrivateNetwork?: boolean | null;
    allowPrivateNetwork?: boolean | null;
    lookupFn?: LookupFn;
    errorMessage?: string;
}): Promise<void>;
/** Normalize suffix-style host allowlists into lowercase canonical entries with wildcard collapse. */
export declare function normalizeHostnameSuffixAllowlist(input?: readonly string[], defaults?: readonly string[]): string[];
/** Check whether a URL is HTTPS and its hostname matches the normalized suffix allowlist. */
export declare function isHttpsUrlAllowedByHostnameSuffixAllowlist(url: string, allowlist: readonly string[]): boolean;
/**
 * Converts suffix-style host allowlists (for example "example.com") into SSRF
 * hostname allowlist patterns used by the shared fetch guard.
 *
 * Suffix semantics:
 * - "example.com" allows "example.com" and "*.example.com"
 * - "*" disables hostname allowlist restrictions
 */
export declare function buildHostnameAllowlistPolicyFromSuffixAllowlist(allowHosts?: readonly string[]): SsrFPolicy | undefined;
