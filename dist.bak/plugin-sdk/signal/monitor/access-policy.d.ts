import { type SignalSender } from "../identity.js";
type SignalDmPolicy = "open" | "pairing" | "allowlist" | "disabled";
type SignalGroupPolicy = "open" | "allowlist" | "disabled";
export declare function resolveSignalAccessState(params: {
    accountId: string;
    dmPolicy: SignalDmPolicy;
    groupPolicy: SignalGroupPolicy;
    allowFrom: string[];
    groupAllowFrom: string[];
    sender: SignalSender;
}): Promise<{
    resolveAccessDecision: (isGroup: boolean) => {
        decision: import("../../security/dm-policy-shared.js").DmGroupAccessDecision;
        reasonCode: import("../../security/dm-policy-shared.js").DmGroupAccessReasonCode;
        reason: string;
        effectiveAllowFrom: string[];
        effectiveGroupAllowFrom: string[];
    };
    dmAccess: {
        decision: import("../../security/dm-policy-shared.js").DmGroupAccessDecision;
        reasonCode: import("../../security/dm-policy-shared.js").DmGroupAccessReasonCode;
        reason: string;
        effectiveAllowFrom: string[];
        effectiveGroupAllowFrom: string[];
    };
    effectiveDmAllow: string[];
    effectiveGroupAllow: string[];
}>;
export declare function handleSignalDirectMessageAccess(params: {
    dmPolicy: SignalDmPolicy;
    dmAccessDecision: "allow" | "block" | "pairing";
    senderId: string;
    senderIdLine: string;
    senderDisplay: string;
    senderName?: string;
    accountId: string;
    sendPairingReply: (text: string) => Promise<void>;
    log: (message: string) => void;
}): Promise<boolean>;
export {};
