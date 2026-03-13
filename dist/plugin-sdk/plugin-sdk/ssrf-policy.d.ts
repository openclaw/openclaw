import type { SsrFPolicy } from "../infra/net/ssrf.js";
export declare function normalizeHostnameSuffixAllowlist(input?: readonly string[], defaults?: readonly string[]): string[];
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
