import type { ChannelMessageAdapterShape, ChannelMessageLiveCapability, ChannelMessageReceiveAckPolicy, DurableFinalDeliveryCapability, DurableFinalDeliveryRequirementMap, LivePreviewFinalizerCapability, LivePreviewFinalizerCapabilityMap } from "./types.js";
export type DurableFinalCapabilityProof = () => Promise<void> | void;
export type DurableFinalCapabilityProofMap = Partial<Record<DurableFinalDeliveryCapability, DurableFinalCapabilityProof>>;
export type DurableFinalCapabilityProofResult = {
    capability: DurableFinalDeliveryCapability;
    status: "verified" | "not_declared";
};
export type LivePreviewFinalizerCapabilityProof = () => Promise<void> | void;
export type ChannelMessageLiveCapabilityProof = () => Promise<void> | void;
export type ChannelMessageReceiveAckPolicyProof = () => Promise<void> | void;
export type LivePreviewFinalizerCapabilityProofMap = Partial<Record<LivePreviewFinalizerCapability, LivePreviewFinalizerCapabilityProof>>;
export type ChannelMessageLiveCapabilityProofMap = Partial<Record<ChannelMessageLiveCapability, ChannelMessageLiveCapabilityProof>>;
export type ChannelMessageReceiveAckPolicyProofMap = Partial<Record<ChannelMessageReceiveAckPolicy, ChannelMessageReceiveAckPolicyProof>>;
export type LivePreviewFinalizerCapabilityProofResult = {
    capability: LivePreviewFinalizerCapability;
    status: "verified" | "not_declared";
};
export type ChannelMessageLiveCapabilityProofResult = {
    capability: ChannelMessageLiveCapability;
    status: "verified" | "not_declared";
};
export type ChannelMessageReceiveAckPolicyProofResult = {
    policy: ChannelMessageReceiveAckPolicy;
    status: "verified" | "not_declared";
};
export declare function listDeclaredDurableFinalCapabilities(capabilities: DurableFinalDeliveryRequirementMap | undefined): DurableFinalDeliveryCapability[];
export declare function listDeclaredLivePreviewFinalizerCapabilities(capabilities: LivePreviewFinalizerCapabilityMap | undefined): LivePreviewFinalizerCapability[];
export declare function listDeclaredChannelMessageLiveCapabilities(capabilities: Partial<Record<ChannelMessageLiveCapability, boolean>> | undefined): ChannelMessageLiveCapability[];
export declare function listDeclaredReceiveAckPolicies(receive: ChannelMessageAdapterShape["receive"] | undefined): ChannelMessageReceiveAckPolicy[];
export declare function verifyDurableFinalCapabilityProofs(params: {
    adapterName: string;
    capabilities?: DurableFinalDeliveryRequirementMap;
    proofs: DurableFinalCapabilityProofMap;
}): Promise<DurableFinalCapabilityProofResult[]>;
export declare function verifyLivePreviewFinalizerCapabilityProofs(params: {
    adapterName: string;
    capabilities?: LivePreviewFinalizerCapabilityMap;
    proofs: LivePreviewFinalizerCapabilityProofMap;
}): Promise<LivePreviewFinalizerCapabilityProofResult[]>;
export declare function verifyChannelMessageLiveCapabilityProofs(params: {
    adapterName: string;
    capabilities?: Partial<Record<ChannelMessageLiveCapability, boolean>>;
    proofs: ChannelMessageLiveCapabilityProofMap;
}): Promise<ChannelMessageLiveCapabilityProofResult[]>;
export declare function verifyChannelMessageReceiveAckPolicyProofs(params: {
    adapterName: string;
    receive?: ChannelMessageAdapterShape["receive"];
    proofs: ChannelMessageReceiveAckPolicyProofMap;
}): Promise<ChannelMessageReceiveAckPolicyProofResult[]>;
export declare function verifyChannelMessageAdapterCapabilityProofs(params: {
    adapterName: string;
    adapter: Pick<ChannelMessageAdapterShape, "durableFinal">;
    proofs: DurableFinalCapabilityProofMap;
}): Promise<DurableFinalCapabilityProofResult[]>;
export declare function verifyChannelMessageReceiveAckPolicyAdapterProofs(params: {
    adapterName: string;
    adapter: Pick<ChannelMessageAdapterShape, "receive">;
    proofs: ChannelMessageReceiveAckPolicyProofMap;
}): Promise<ChannelMessageReceiveAckPolicyProofResult[]>;
export declare function verifyChannelMessageLiveFinalizerProofs(params: {
    adapterName: string;
    adapter: Pick<ChannelMessageAdapterShape, "live">;
    proofs: LivePreviewFinalizerCapabilityProofMap;
}): Promise<LivePreviewFinalizerCapabilityProofResult[]>;
export declare function verifyChannelMessageLiveCapabilityAdapterProofs(params: {
    adapterName: string;
    adapter: Pick<ChannelMessageAdapterShape, "live">;
    proofs: ChannelMessageLiveCapabilityProofMap;
}): Promise<ChannelMessageLiveCapabilityProofResult[]>;
