import { _ as GroupPolicy } from "./types.base-CN1BlTRP.js";

//#region src/plugin-sdk/group-access.d.ts
type SenderGroupAccessReason = "allowed" | "disabled" | "empty_allowlist" | "sender_not_allowlisted";
type SenderGroupAccessDecision = {
  allowed: boolean;
  groupPolicy: GroupPolicy;
  providerMissingFallbackApplied: boolean;
  reason: SenderGroupAccessReason;
};
type GroupRouteAccessReason = "allowed" | "disabled" | "empty_allowlist" | "route_not_allowlisted" | "route_disabled";
type GroupRouteAccessDecision = {
  allowed: boolean;
  groupPolicy: GroupPolicy;
  reason: GroupRouteAccessReason;
};
type MatchedGroupAccessReason = "allowed" | "disabled" | "missing_match_input" | "empty_allowlist" | "not_allowlisted";
type MatchedGroupAccessDecision = {
  allowed: boolean;
  groupPolicy: GroupPolicy;
  reason: MatchedGroupAccessReason;
};
/** Downgrade sender-scoped group policy to open mode when no allowlist is configured. */
declare function resolveSenderScopedGroupPolicy(params: {
  groupPolicy: GroupPolicy;
  groupAllowFrom: string[];
}): GroupPolicy;
/** Evaluate route-level group access after policy, route match, and enablement checks. */
declare function evaluateGroupRouteAccessForPolicy(params: {
  groupPolicy: GroupPolicy;
  routeAllowlistConfigured: boolean;
  routeMatched: boolean;
  routeEnabled?: boolean;
}): GroupRouteAccessDecision;
/** Evaluate generic allowlist match state for channels that compare derived group identifiers. */
declare function evaluateMatchedGroupAccessForPolicy(params: {
  groupPolicy: GroupPolicy;
  allowlistConfigured: boolean;
  allowlistMatched: boolean;
  requireMatchInput?: boolean;
  hasMatchInput?: boolean;
}): MatchedGroupAccessDecision;
/** Evaluate sender access for an already-resolved group policy and allowlist. */
declare function evaluateSenderGroupAccessForPolicy(params: {
  groupPolicy: GroupPolicy;
  providerMissingFallbackApplied?: boolean;
  groupAllowFrom: string[];
  senderId: string;
  isSenderAllowed: (senderId: string, allowFrom: string[]) => boolean;
}): SenderGroupAccessDecision;
/** Resolve provider fallback policy first, then evaluate sender access against that result. */
declare function evaluateSenderGroupAccess(params: {
  providerConfigPresent: boolean;
  configuredGroupPolicy?: GroupPolicy;
  defaultGroupPolicy?: GroupPolicy;
  groupAllowFrom: string[];
  senderId: string;
  isSenderAllowed: (senderId: string, allowFrom: string[]) => boolean;
}): SenderGroupAccessDecision;
//#endregion
export { SenderGroupAccessDecision as a, evaluateMatchedGroupAccessForPolicy as c, resolveSenderScopedGroupPolicy as d, MatchedGroupAccessReason as i, evaluateSenderGroupAccess as l, GroupRouteAccessReason as n, SenderGroupAccessReason as o, MatchedGroupAccessDecision as r, evaluateGroupRouteAccessForPolicy as s, GroupRouteAccessDecision as t, evaluateSenderGroupAccessForPolicy as u };