import { i as OpenClawConfig } from "./types.openclaw-BLF4DJTX.js";
import { o as SsrFPolicy, t as LookupFn } from "./ssrf-skjEI_i5.js";
import { C as ChannelDoctorConfigMutation, T as ChannelDoctorLegacyConfigRule } from "./types.adapters-y0dBEomF.js";
//#region src/plugin-sdk/ssrf-policy.d.ts
type PrivateNetworkOptInInput = boolean | null | undefined | Pick<SsrFPolicy, "allowPrivateNetwork" | "dangerouslyAllowPrivateNetwork"> | {
  dangerouslyAllowPrivateNetwork?: boolean | null; /** @deprecated Compatibility alias; prefer dangerouslyAllowPrivateNetwork. */
  allowPrivateNetwork?: boolean | null;
  network?: Pick<SsrFPolicy, "allowPrivateNetwork" | "dangerouslyAllowPrivateNetwork"> | null | undefined;
};
declare function isPrivateNetworkOptInEnabled(input: PrivateNetworkOptInInput): boolean;
declare function ssrfPolicyFromPrivateNetworkOptIn(input: PrivateNetworkOptInInput): SsrFPolicy | undefined;
declare function ssrfPolicyFromDangerouslyAllowPrivateNetwork(dangerouslyAllowPrivateNetwork: boolean | null | undefined): SsrFPolicy | undefined;
declare function hasLegacyFlatAllowPrivateNetworkAlias(value: unknown): boolean;
declare function migrateLegacyFlatAllowPrivateNetworkAlias(params: {
  entry: Record<string, unknown>;
  pathPrefix: string;
  changes: string[];
}): {
  entry: Record<string, unknown>;
  changed: boolean;
};
declare function createLegacyPrivateNetworkDoctorContract(params: {
  channelKey: string;
}): {
  legacyConfigRules: ChannelDoctorLegacyConfigRule[];
  normalizeCompatibilityConfig: (params: {
    cfg: OpenClawConfig;
  }) => ChannelDoctorConfigMutation;
};
declare function ssrfPolicyFromAllowPrivateNetwork(allowPrivateNetwork: boolean | null | undefined): SsrFPolicy | undefined;
declare function assertHttpUrlTargetsPrivateNetwork(url: string, params?: {
  dangerouslyAllowPrivateNetwork?: boolean | null;
  allowPrivateNetwork?: boolean | null;
  lookupFn?: LookupFn;
  errorMessage?: string;
}): Promise<void>;
/** Normalize suffix-style host allowlists into lowercase canonical entries with wildcard collapse. */
declare function normalizeHostnameSuffixAllowlist(input?: readonly string[], defaults?: readonly string[]): string[];
/** Check whether a URL is HTTPS and its hostname matches the normalized suffix allowlist. */
declare function isHttpsUrlAllowedByHostnameSuffixAllowlist(url: string, allowlist: readonly string[]): boolean;
/**
 * Converts suffix-style host allowlists (for example "example.com") into SSRF
 * hostname allowlist patterns used by the shared fetch guard.
 *
 * Suffix semantics:
 * - "example.com" allows "example.com" and "*.example.com"
 * - "*" disables hostname allowlist restrictions
 */
declare function buildHostnameAllowlistPolicyFromSuffixAllowlist(allowHosts?: readonly string[]): SsrFPolicy | undefined;
//#endregion
export { hasLegacyFlatAllowPrivateNetworkAlias as a, migrateLegacyFlatAllowPrivateNetworkAlias as c, ssrfPolicyFromDangerouslyAllowPrivateNetwork as d, ssrfPolicyFromPrivateNetworkOptIn as f, createLegacyPrivateNetworkDoctorContract as i, normalizeHostnameSuffixAllowlist as l, assertHttpUrlTargetsPrivateNetwork as n, isHttpsUrlAllowedByHostnameSuffixAllowlist as o, buildHostnameAllowlistPolicyFromSuffixAllowlist as r, isPrivateNetworkOptInEnabled as s, PrivateNetworkOptInInput as t, ssrfPolicyFromAllowPrivateNetwork as u };