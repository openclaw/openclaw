import type { GroupPolicy } from "../config/types.base.js";
export type SenderGroupAccessReason = "allowed" | "disabled" | "empty_allowlist" | "sender_not_allowlisted";
export type SenderGroupAccessDecision = {
    allowed: boolean;
    groupPolicy: GroupPolicy;
    providerMissingFallbackApplied: boolean;
    reason: SenderGroupAccessReason;
};
export type GroupRouteAccessReason = "allowed" | "disabled" | "empty_allowlist" | "route_not_allowlisted" | "route_disabled";
export type GroupRouteAccessDecision = {
    allowed: boolean;
    groupPolicy: GroupPolicy;
    reason: GroupRouteAccessReason;
};
export type MatchedGroupAccessReason = "allowed" | "disabled" | "missing_match_input" | "empty_allowlist" | "not_allowlisted";
export type MatchedGroupAccessDecision = {
    allowed: boolean;
    groupPolicy: GroupPolicy;
    reason: MatchedGroupAccessReason;
};
export declare function resolveSenderScopedGroupPolicy(params: {
    groupPolicy: GroupPolicy;
    groupAllowFrom: string[];
}): GroupPolicy;
export declare function evaluateGroupRouteAccessForPolicy(params: {
    groupPolicy: GroupPolicy;
    routeAllowlistConfigured: boolean;
    routeMatched: boolean;
    routeEnabled?: boolean;
}): GroupRouteAccessDecision;
export declare function evaluateMatchedGroupAccessForPolicy(params: {
    groupPolicy: GroupPolicy;
    allowlistConfigured: boolean;
    allowlistMatched: boolean;
    requireMatchInput?: boolean;
    hasMatchInput?: boolean;
}): MatchedGroupAccessDecision;
export declare function evaluateSenderGroupAccessForPolicy(params: {
    groupPolicy: GroupPolicy;
    providerMissingFallbackApplied?: boolean;
    groupAllowFrom: string[];
    senderId: string;
    isSenderAllowed: (senderId: string, allowFrom: string[]) => boolean;
}): SenderGroupAccessDecision;
export declare function evaluateSenderGroupAccess(params: {
    providerConfigPresent: boolean;
    configuredGroupPolicy?: GroupPolicy;
    defaultGroupPolicy?: GroupPolicy;
    groupAllowFrom: string[];
    senderId: string;
    isSenderAllowed: (senderId: string, allowFrom: string[]) => boolean;
}): SenderGroupAccessDecision;
