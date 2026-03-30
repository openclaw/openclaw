import type { GroupPolicy } from "./types.base.js";
export type RuntimeGroupPolicyResolution = {
    groupPolicy: GroupPolicy;
    providerMissingFallbackApplied: boolean;
};
export type RuntimeGroupPolicyParams = {
    providerConfigPresent: boolean;
    groupPolicy?: GroupPolicy;
    defaultGroupPolicy?: GroupPolicy;
    configuredFallbackPolicy?: GroupPolicy;
    missingProviderFallbackPolicy?: GroupPolicy;
};
export declare function resolveRuntimeGroupPolicy(params: RuntimeGroupPolicyParams): RuntimeGroupPolicyResolution;
export type ResolveProviderRuntimeGroupPolicyParams = {
    providerConfigPresent: boolean;
    groupPolicy?: GroupPolicy;
    defaultGroupPolicy?: GroupPolicy;
};
export type GroupPolicyDefaultsConfig = {
    channels?: {
        defaults?: {
            groupPolicy?: GroupPolicy;
        };
    };
};
export declare function resolveDefaultGroupPolicy(cfg: GroupPolicyDefaultsConfig): GroupPolicy | undefined;
export declare const GROUP_POLICY_BLOCKED_LABEL: {
    readonly group: "group messages";
    readonly guild: "guild messages";
    readonly room: "room messages";
    readonly channel: "channel messages";
    readonly space: "space messages";
};
/**
 * Standard provider runtime policy:
 * - configured provider fallback: open
 * - missing provider fallback: allowlist (fail-closed)
 */
export declare function resolveOpenProviderRuntimeGroupPolicy(params: ResolveProviderRuntimeGroupPolicyParams): RuntimeGroupPolicyResolution;
/**
 * Strict provider runtime policy:
 * - configured provider fallback: allowlist
 * - missing provider fallback: allowlist (fail-closed)
 */
export declare function resolveAllowlistProviderRuntimeGroupPolicy(params: ResolveProviderRuntimeGroupPolicyParams): RuntimeGroupPolicyResolution;
export declare function warnMissingProviderGroupPolicyFallbackOnce(params: {
    providerMissingFallbackApplied: boolean;
    providerKey: string;
    accountId?: string;
    blockedLabel?: string;
    log: (message: string) => void;
}): boolean;
/**
 * Test helper. Keeps warning-cache state deterministic across test files.
 */
export declare function resetMissingProviderGroupPolicyFallbackWarningsForTesting(): void;
