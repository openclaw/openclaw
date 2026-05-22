import type { ChannelIngressPolicyInput, ChannelIngressState, IngressReasonCode, RedactedIngressAllowlistFacts, ResolvedIngressAllowlist } from "./types.js";
export declare function allowlistFailureReason(allowlist: ResolvedIngressAllowlist): IngressReasonCode | null;
export declare function redactedAllowlistDiagnostics(allowlist: ResolvedIngressAllowlist, reasonCode: IngressReasonCode): RedactedIngressAllowlistFacts;
export declare function applyMutableIdentifierPolicy(allowlist: ResolvedIngressAllowlist, policy: ChannelIngressPolicyInput): ResolvedIngressAllowlist;
export declare function effectiveGroupSenderAllowlist(params: {
    state: ChannelIngressState;
    policy: ChannelIngressPolicyInput;
}): ResolvedIngressAllowlist;
