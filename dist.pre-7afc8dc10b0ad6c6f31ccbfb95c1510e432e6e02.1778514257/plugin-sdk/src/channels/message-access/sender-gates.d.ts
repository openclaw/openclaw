import type { AccessGraphGate, ChannelIngressPolicyInput, ChannelIngressState } from "./types.js";
export declare function senderGateForDirect(params: {
    state: ChannelIngressState;
    policy: ChannelIngressPolicyInput;
}): AccessGraphGate;
export declare function senderGateForGroup(params: {
    state: ChannelIngressState;
    policy: ChannelIngressPolicyInput;
}): AccessGraphGate;
export declare function applyEventAuthModeToSenderGate(params: {
    state: ChannelIngressState;
    senderGate: AccessGraphGate;
}): AccessGraphGate;
