import type { GroupPolicy } from "../config/types.base.js";
export type SenderGroupAccessReason = "allowed" | "disabled" | "empty_allowlist" | "sender_not_allowlisted";
export type SenderGroupAccessDecision = {
    allowed: boolean;
    groupPolicy: GroupPolicy;
    providerMissingFallbackApplied: boolean;
    reason: SenderGroupAccessReason;
};
export declare function evaluateSenderGroupAccess(params: {
    providerConfigPresent: boolean;
    configuredGroupPolicy?: GroupPolicy;
    defaultGroupPolicy?: GroupPolicy;
    groupAllowFrom: string[];
    senderId: string;
    isSenderAllowed: (senderId: string, allowFrom: string[]) => boolean;
}): SenderGroupAccessDecision;
