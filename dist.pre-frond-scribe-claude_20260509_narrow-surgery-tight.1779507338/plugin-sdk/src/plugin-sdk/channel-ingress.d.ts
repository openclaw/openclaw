import { decideChannelIngress } from "../channels/message-access/index.js";
import type { AccessGraphGate, ChannelIngressDecision, ChannelIngressIdentifierKind, ChannelIngressPolicyInput, ChannelIngressState, ChannelIngressStateInput as MessageAccessChannelIngressStateInput, IngressGateKind, IngressGatePhase, InternalChannelIngressAdapter, InternalChannelIngressNormalizeResult, InternalChannelIngressSubject, InternalMatchMaterial, InternalNormalizedEntry, IngressReasonCode } from "../channels/message-access/index.js";
import type { AccessFacts, ChannelTurnAdmission } from "../channels/turn/types.js";
import type { DmGroupAccessDecision, DmGroupAccessReasonCode } from "../security/dm-policy-shared.js";
export { decideChannelIngress };
export type { AccessGraph, AccessGraphGate, AccessGroupMembershipFact, ChannelIngressAdmission, ChannelIngressChannelId, ChannelIngressDecision, ChannelIngressEventInput, ChannelIngressIdentifierKind, ChannelIngressNormalizedEntry, ChannelIngressPolicyInput, ChannelIngressState, IngressGateEffect, IngressGateKind, IngressGatePhase, IngressReasonCode, MatchableIdentifier, RedactedChannelIngressEvent, RedactedIngressAllowlistFacts, RedactedIngressEntryDiagnostic, RedactedIngressMatch, ResolvedIngressAllowlist, ResolvedRouteGateFacts, RouteGateFacts, RouteGateState, RouteSenderAllowlistSource, RouteSenderPolicy, } from "../channels/message-access/index.js";
export type ChannelIngressSubjectIdentifier = InternalMatchMaterial;
export type ChannelIngressSubject = InternalChannelIngressSubject;
export type ChannelIngressAdapterEntry = InternalNormalizedEntry;
export type ChannelIngressAdapterNormalizeResult = InternalChannelIngressNormalizeResult;
export type ChannelIngressAdapter = InternalChannelIngressAdapter;
export type ChannelIngressStateInput = MessageAccessChannelIngressStateInput;
declare const CHANNEL_INGRESS_PLUGIN_ID: unique symbol;
export type ChannelIngressPluginId = string & {
    readonly [CHANNEL_INGRESS_PLUGIN_ID]: true;
};
export type ChannelIngressGateSelector = {
    phase: IngressGatePhase;
    kind: IngressGateKind;
};
export type ChannelIngressDecisionBundle = {
    dm: ChannelIngressDecision;
    group: ChannelIngressDecision;
    dmCommand: ChannelIngressDecision;
    groupCommand: ChannelIngressDecision;
};
export type ChannelIngressSideEffectResult = {
    kind: "none";
} | {
    kind: "pairing-reply-sent";
} | {
    kind: "pairing-reply-failed";
    errorCode?: string;
} | {
    kind: "command-reply-sent";
} | {
    kind: "command-reply-failed";
    errorCode?: string;
} | {
    kind: "pending-history-recorded";
} | {
    kind: "local-event-handled";
};
export type RedactedIngressDiagnostics = {
    decisiveGateId?: string;
    reasonCode: IngressReasonCode;
};
export declare const CHANNEL_INGRESS_GATE_SELECTORS: {
    readonly command: {
        readonly phase: "command";
        readonly kind: "command";
    };
    readonly activation: {
        readonly phase: "activation";
        readonly kind: "mention";
    };
    readonly dmSender: {
        readonly phase: "sender";
        readonly kind: "dmSender";
    };
    readonly groupSender: {
        readonly phase: "sender";
        readonly kind: "groupSender";
    };
    readonly event: {
        readonly phase: "event";
        readonly kind: "event";
    };
};
export type ChannelIngressSubjectIdentifierInput = {
    value: string;
    opaqueId?: string;
    kind?: ChannelIngressIdentifierKind;
    dangerous?: boolean;
    sensitivity?: "normal" | "pii";
};
export type CreateChannelIngressStringAdapterParams = {
    kind?: ChannelIngressIdentifierKind;
    normalizeEntry?: (value: string) => string | null | undefined;
    normalizeSubject?: (value: string) => string | null | undefined;
    isWildcardEntry?: (value: string) => boolean;
    resolveEntryId?: (params: {
        entry: string;
        index: number;
    }) => string;
    dangerous?: boolean | ((entry: string) => boolean);
    sensitivity?: "normal" | "pii";
};
export type CreateChannelIngressMultiIdentifierAdapterParams = {
    normalizeEntry: (entry: string, index: number) => readonly ChannelIngressAdapterEntry[];
    getEntryMatchKey?: (entry: ChannelIngressAdapterEntry) => string | null | undefined;
    getSubjectMatchKeys?: (identifier: ChannelIngressSubjectIdentifier) => readonly (string | null | undefined)[];
    isWildcardEntry?: (entry: ChannelIngressAdapterEntry) => boolean;
};
export type ChannelIngressDmGroupAccessProjection = {
    decision: DmGroupAccessDecision;
    reasonCode: DmGroupAccessReasonCode;
    reason: string;
};
export type ChannelIngressSenderGroupAccessProjection = {
    allowed: boolean;
    groupPolicy: ChannelIngressPolicyInput["groupPolicy"];
    providerMissingFallbackApplied: boolean;
    reason: "allowed" | "disabled" | "empty_allowlist" | "sender_not_allowlisted";
};
/** @deprecated Use `resolveChannelMessageIngress` from `openclaw/plugin-sdk/channel-ingress-runtime`. */
export type ResolveChannelIngressAccessParams = ChannelIngressStateInput & {
    policy: ChannelIngressPolicyInput;
    effectiveAllowFrom?: readonly string[];
    effectiveGroupAllowFrom?: readonly string[];
};
/** @deprecated Use `resolveChannelMessageIngress` from `openclaw/plugin-sdk/channel-ingress-runtime`. */
export type ResolvedChannelIngressAccess = {
    state: ChannelIngressState;
    ingress: ChannelIngressDecision;
    isGroup: boolean;
    senderReasonCode: IngressReasonCode;
    access: ChannelIngressDmGroupAccessProjection & {
        effectiveAllowFrom: string[];
        effectiveGroupAllowFrom: string[];
    };
    commandAuthorized: boolean;
    shouldBlockControlCommand: boolean;
};
export declare function findChannelIngressGate(decision: ChannelIngressDecision, selector: ChannelIngressGateSelector): AccessGraphGate | undefined;
export declare function findChannelIngressSenderGate(decision: ChannelIngressDecision, params: {
    isGroup: boolean;
}): AccessGraphGate | undefined;
export declare function findChannelIngressCommandGate(decision: ChannelIngressDecision): AccessGraphGate | undefined;
export declare function decideChannelIngressBundle(params: {
    directState: ChannelIngressState;
    groupState: ChannelIngressState;
    basePolicy: ChannelIngressPolicyInput;
    commandPolicy: ChannelIngressPolicyInput;
}): ChannelIngressDecisionBundle;
export declare function projectIngressAccessFacts(decision: ChannelIngressDecision): AccessFacts;
export declare function mapChannelIngressDecisionToTurnAdmission(decision: ChannelIngressDecision, sideEffect: ChannelIngressSideEffectResult): ChannelTurnAdmission;
export declare function createChannelIngressPluginId(id: string): ChannelIngressPluginId;
export declare function createChannelIngressSubject(input: ChannelIngressSubjectIdentifierInput | {
    identifiers: readonly ChannelIngressSubjectIdentifierInput[];
}): ChannelIngressSubject;
export declare function createChannelIngressStringAdapter(params?: CreateChannelIngressStringAdapterParams): ChannelIngressAdapter;
export declare function createChannelIngressMultiIdentifierAdapter(params: CreateChannelIngressMultiIdentifierAdapterParams): ChannelIngressAdapter;
export declare function assertNeverChannelIngressReason(reasonCode: never): never;
/** @deprecated Use `senderAccess.reasonCode` from `resolveChannelMessageIngress(...)` or typed gate selectors. */
export declare function findChannelIngressSenderReasonCode(decision: ChannelIngressDecision, params: {
    isGroup: boolean;
}): IngressReasonCode;
/** @deprecated Use `senderAccess.reasonCode` from `resolveChannelMessageIngress(...)`. */
export declare function mapChannelIngressReasonCodeToDmGroupAccessReason(params: {
    reasonCode: IngressReasonCode;
    isGroup: boolean;
}): DmGroupAccessReasonCode;
/** @deprecated Use `senderAccess.reason` from `resolveChannelMessageIngress(...)`. */
export declare function formatChannelIngressPolicyReason(params: {
    reasonCode: DmGroupAccessReasonCode;
    dmPolicy: string;
    groupPolicy: string;
}): string;
/** @deprecated Use `senderAccess.groupAccess` from `resolveChannelMessageIngress(...)`. */
export declare function projectChannelIngressSenderGroupAccess(params: {
    reasonCode: IngressReasonCode;
    decisionAllowed: boolean;
    groupPolicy: ChannelIngressPolicyInput["groupPolicy"];
    providerMissingFallbackApplied?: boolean;
}): ChannelIngressSenderGroupAccessProjection;
/** @deprecated Use `senderAccess` from `resolveChannelMessageIngress(...)`. */
export declare function projectChannelIngressDmGroupAccess(params: {
    ingress: ChannelIngressDecision;
    isGroup: boolean;
    dmPolicy: string;
    groupPolicy: string;
}): ChannelIngressDmGroupAccessProjection;
export declare function resolveChannelIngressState(input: ChannelIngressStateInput): Promise<ChannelIngressState>;
/** @deprecated Use `resolveChannelMessageIngress` from `openclaw/plugin-sdk/channel-ingress-runtime`. */
export declare function resolveChannelIngressAccess(params: ResolveChannelIngressAccessParams): Promise<ResolvedChannelIngressAccess>;
