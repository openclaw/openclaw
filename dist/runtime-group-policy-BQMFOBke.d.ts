import { _ as GroupPolicy } from "./types.base-DS--yneR.js";

//#region src/config/runtime-group-policy.d.ts
type RuntimeGroupPolicyResolution = {
  groupPolicy: GroupPolicy;
  providerMissingFallbackApplied: boolean;
};
type ResolveProviderRuntimeGroupPolicyParams = {
  providerConfigPresent: boolean;
  groupPolicy?: GroupPolicy;
  defaultGroupPolicy?: GroupPolicy;
};
type GroupPolicyDefaultsConfig = {
  channels?: {
    defaults?: {
      groupPolicy?: GroupPolicy;
    };
  };
};
declare function resolveDefaultGroupPolicy(cfg: GroupPolicyDefaultsConfig): GroupPolicy | undefined;
declare const GROUP_POLICY_BLOCKED_LABEL: {
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
declare function resolveOpenProviderRuntimeGroupPolicy(params: ResolveProviderRuntimeGroupPolicyParams): RuntimeGroupPolicyResolution;
/**
 * Strict provider runtime policy:
 * - configured provider fallback: allowlist
 * - missing provider fallback: allowlist (fail-closed)
 */
declare function resolveAllowlistProviderRuntimeGroupPolicy(params: ResolveProviderRuntimeGroupPolicyParams): RuntimeGroupPolicyResolution;
declare function warnMissingProviderGroupPolicyFallbackOnce(params: {
  providerMissingFallbackApplied: boolean;
  providerKey: string;
  accountId?: string;
  blockedLabel?: string;
  log: (message: string) => void;
}): boolean;
//#endregion
export { warnMissingProviderGroupPolicyFallbackOnce as a, resolveOpenProviderRuntimeGroupPolicy as i, resolveAllowlistProviderRuntimeGroupPolicy as n, resolveDefaultGroupPolicy as r, GROUP_POLICY_BLOCKED_LABEL as t };